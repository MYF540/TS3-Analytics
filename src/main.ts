import { startServer } from './api/server.js';
import { loadConfigOrExit } from './config/config.js';
import { openDatabase, runMigrations } from './db/client.js';
import { openCountryLookup } from './geoip/country-lookup.js';
import { deleteExpiredSessions } from './api/auth/service.js';
import { runMaintenance, runRetention } from './jobs/retention.js';
import { runFlagDetection } from './jobs/flag-detection.js';
import { JobRunner } from './jobs/runner.js';
import { createLogger } from './logging/logger.js';
import { Ts3Connection } from './ts3/connection.js';
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
  const watcher = new Watcher({
    database,
    connection,
    logger,
    ip: { countries, hmacSecret: config.security.hmacSecret },
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
  rankJob.start();
  connection.start();

  const jobs = new JobRunner(
    [
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
        name: 'flag-detection',
        intervalS: 15 * 60,
        run: (now) => detectFlags(now),
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
