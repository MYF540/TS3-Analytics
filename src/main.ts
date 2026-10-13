/*
 * TS3 Analytics – Statistiken, Leaderboards und Rangsystem für TeamSpeak-3-Server.
 * Copyright (C) 2026 MYF540
 *
 * This program is free software: you can redistribute it and/or modify it under the terms of
 * the GNU Affero General Public License as published by the Free Software Foundation, either
 * version 3 of the License, or (at your option) any later version. It is distributed WITHOUT
 * ANY WARRANTY; see the LICENSE file or <https://www.gnu.org/licenses/> for details.
 */
import { startServer } from './api/server.js';
import { loadConfigOrExit } from './config/config.js';
import { AutomationHost } from './automation/host.js';
import { ChannelsModule } from './automation/modules/channels.js';
import { NicknameModule } from './automation/modules/nickname.js';
import { PrivateModule } from './automation/modules/private.js';
import { ProxyModule } from './automation/modules/proxy.js';
import { RulesModule } from './automation/modules/rules.js';
import { SpamModule } from './automation/modules/spam.js';
import { StaffModule } from './automation/modules/staff.js';
import { SupportModule } from './automation/modules/support.js';
import { createProxycheckLookup } from './automation/proxycheck.js';
import { openDatabase, runMigrations } from './db/client.js';
import { openCountryLookup } from './geoip/country-lookup.js';
import { deleteExpiredSessions } from './api/auth/service.js';
import { runMaintenance, runRetention } from './jobs/retention.js';
import { runBackup } from './jobs/backup.js';
import { runFlagDetection } from './jobs/flag-detection.js';
import { runNetworkJob } from './network/job.js';
import { JobRunner } from './jobs/runner.js';
import { createLogger } from './logging/logger.js';
import { Ts3Connection } from './ts3/connection.js';
import { Updater } from './update/updater.js';
import { readVersion } from './api/routes/status.js';
import { RealTs3Transport } from './ts3/real-transport.js';
import { ConnectionAlerts } from './alerts/connection.js';
import { alertNewBans, alertNewFlags } from './alerts/dispatch.js';
import { JoinSpikeDetector } from './alerts/join-spike.js';
import { AlertNotifier } from './alerts/notifier.js';
import { RankJob } from './ranks/job.js';
import { BanSync } from './watcher/bans.js';
import { GroupWatch } from './watcher/group-watch.js';
import { Watcher } from './watcher/watcher.js';

async function main(): Promise<void> {
  const config = loadConfigOrExit();
  const logger = createLogger(config.logging);
  logger.info(
    { logLevel: config.logging.level, logDir: config.logging.dir },
    'TS3 Analytics starting',
  );
  const database = openDatabase(config.database);
  runMigrations(database);
  logger.info({ path: config.database.path }, 'Database ready');

  const connection = new Ts3Connection(
    () => new RealTs3Transport(config.ts3, logger),
    { commandsPerSecond: config.ts3.queryRateLimit },
    { logger },
  );
  const countries = await openCountryLookup(config.paths.geoipDb, logger);
  // Filled in further down, once the automation host exists; until then nothing is inspected.
  const proxy: { module?: ProxyModule } = {};
  const watcher = new Watcher({
    database,
    connection,
    logger,
    ip: {
      countries,
      hmacSecret: config.security.hmacSecret,
      onAddress: (client, ip, ipHash) => proxy.module?.inspect(client, ip, ipHash),
    },
    pollIntervalS: config.watcher.pollIntervalS,
    flushIntervalS: config.watcher.flushIntervalS,
    resumeGraceS: config.watcher.resumeGraceS,
  });
  watcher.start();
  const alerts = new AlertNotifier({ db: database.db, logger });
  watcher.tracker.addListener(new JoinSpikeDetector(database, alerts, logger));
  const connectionAlerts = new ConnectionAlerts(connection, alerts);
  connectionAlerts.start();
  /** Flag detection plus alerts for new hints; returns the counts for the job log. */
  const detectFlags = (now: number) => {
    const result = runFlagDetection(database, now);
    alertNewFlags(alerts, database.sqlite, result);
    return { detected: result.detected, created: result.created };
  };
  const banSync = new BanSync({
    database,
    connection,
    logger,
    hmacSecret: config.security.hmacSecret,
    intervalS: config.watcher.banSyncIntervalS,
    onChange: (change) => {
      try {
        alertNewBans(alerts, database.sqlite, change);
        const result = detectFlags(Math.floor(Date.now() / 1000));
        logger.info({ result }, 'Flag detection after ban list change');
      } catch (error) {
        logger.error({ err: error }, 'Flag detection failed');
      }
    },
  });
  banSync.start();
  const groupWatch = new GroupWatch({
    database,
    connection,
    notifier: alerts,
    logger,
    intervalS: config.watcher.groupLogIntervalS,
  });
  groupWatch.start();
  const rankJob = new RankJob({ database, connection, notifier: alerts, logger });
  watcher.tracker.addListener(rankJob);
  // Bot modules (phase 10); each one is off until an admin switches it on.
  const automation = new AutomationHost(logger);
  const automationDeps = {
    database,
    commands: connection,
    logger,
    now: () => Math.floor(Date.now() / 1000),
  };
  automation.register(new NicknameModule(automationDeps));
  automation.register(
    new SupportModule({ ...automationDeps, online: () => automation.online, notifier: alerts }),
  );
  automation.register(
    new StaffModule({
      ...automationDeps,
      online: () => automation.online,
      members: (groupId) => connection.serverGroupMembers(groupId),
    }),
  );
  automation.register(
    new ChannelsModule({
      ...automationDeps,
      online: () => automation.online,
      channels: () => connection.channelList(),
    }),
  );
  automation.register(
    new PrivateModule({ ...automationDeps, channels: () => connection.channelList() }),
  );
  automation.register(new RulesModule(automationDeps));
  automation.register(new SpamModule(automationDeps));
  proxy.module = new ProxyModule({
    ...automationDeps,
    lookup: createProxycheckLookup({ apiKey: config.proxy.apiKey }),
    client: (clid) => automation.get(clid),
    online: () => automation.online,
    notifier: alerts,
  });
  automation.register(proxy.module);
  connection.on('channelCreated', (event) => {
    automation.onChannelCreatedEvent(event, Math.floor(Date.now() / 1000));
  });
  connection.on('textMessage', (event) => {
    automation.onTextMessage(event, Math.floor(Date.now() / 1000));
  });
  watcher.tracker.addListener(automation);
  rankJob.start();
  connection.start();

  const updater = config.update.check
    ? new Updater({
        db: database.db,
        logger,
        currentVersion: readVersion(),
        repo: config.update.repo,
        // The service runs with the installation as its working directory (see docs/betrieb.md).
        root: process.cwd(),
        serviceName: config.update.serviceName,
        now: () => Math.floor(Date.now() / 1000),
      })
    : undefined;

  const jobs = new JobRunner(
    [
      ...(updater
        ? [
            {
              // Only looks; installing is always started by an admin.
              name: 'update-check',
              intervalS: 86_400,
              run: async () => {
                const latest = await updater.check();
                return { latest: latest.version };
              },
            },
          ]
        : []),
      {
        name: 'retention',
        intervalS: 86_400,
        run: (now) =>
          runRetention(
            database,
            {
              ipRetentionDays: config.retention.ipDays,
              segmentRetentionMonths: config.retention.segmentMonths,
            },
            now,
          ),
      },
      {
        name: 'expired-sessions',
        intervalS: 3600,
        run: (now) => deleteExpiredSessions(database.db, now),
      },
      {
        name: 'backup',
        intervalS: 86_400,
        run: (now) =>
          runBackup(database, { dir: config.backup.dir, keep: config.backup.keep, now }),
      },
      {
        name: 'flag-detection',
        intervalS: 15 * 60,
        run: (now) => detectFlags(now),
      },
      {
        // The player network does not have to be live; once a day is enough (T9.1).
        name: 'network',
        intervalS: 86_400,
        run: (now) => {
          runNetworkJob(database, now);
        },
      },
      {
        name: 'maintenance',
        intervalS: 7 * 86_400,
        run: () => {
          runMaintenance(database.sqlite);
        },
      },
    ],
    { db: database.db, logger },
  );
  jobs.start();

  const api = await startServer(
    {
      database,
      logger,
      ts3: connection,
      live: watcher,
      moderation: connection,
      channels: () => connection.channelList(),
      channelGroups: () => connection.channelGroups(),
      proxyKeyConfigured: config.proxy.apiKey !== undefined,
      updater,
      ranks: rankJob,
      bot: {
        connection: () => connection.status(),
        jobs: () => jobs.status(),
        logDir: config.logging.dir,
      },
      now: () => Math.floor(Date.now() / 1000),
      startedAt: Math.floor(Date.now() / 1000),
      auth: { sessionTtlS: config.web.sessionTtlS, cookieSecure: config.web.cookieSecure },
    },
    config.web,
  );

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'Shutting down');
    jobs.stop();
    banSync.stop();
    groupWatch.stop();
    rankJob.stop();
    connectionAlerts.stop();
    alerts.stop();
    void api.close();
    try {
      watcher.stop();
    } catch (error) {
      logger.error({ err: error }, 'Error while closing open sessions');
    }
    void connection
      .stop()
      .catch((error: unknown) => {
        logger.error({ err: error }, 'Error while closing the TS3 connection');
      })
      .finally(() => {
        database.close();
        logger.flush();
        process.exit(0);
      });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
