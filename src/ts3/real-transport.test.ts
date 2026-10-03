import { EventEmitter } from 'node:events';
import { ResponseError, TeamSpeak } from 'ts3-nodejs-library';
import { describe, expect, it, vi } from 'vitest';
import {
  attachNotificationHandlers,
  channelCreateProps,
  channelEditProps,
  enterViewToClient,
  fetchAllBans,
  toTs3Channel,
  type RawEnterView,
} from './real-transport.js';
import type { Ts3TransportEvents } from './types.js';

const enterView: RawEnterView = {
  clid: '12',
  ctid: '5',
  clientDatabaseId: '345',
  clientUniqueIdentifier: 'abcDEF123+/=',
  clientNickname: 'Alice',
  clientType: 0,
  clientAway: false,
  clientInputMuted: true,
  clientOutputMuted: false,
  clientServergroups: ['8', '12'],
  clientPlatform: 'Windows',
  clientVersion: '3.6.2',
  clientCountry: 'DE',
};

describe('enterViewToClient', () => {
  it('maps the join notification', () => {
    expect(enterViewToClient(enterView)).toEqual({
      clid: 12,
      dbid: 345,
      uid: 'abcDEF123+/=',
      nickname: 'Alice',
      type: 0,
      channelId: 5,
      idleMs: 0,
      away: false,
      inputMuted: true,
      outputMuted: false,
      serverGroups: [8, 12],
      platform: 'Windows',
      version: '3.6.2',
      country: 'DE',
    });
  });

  it('tolerates missing optional fields', () => {
    const minimal = enterViewToClient({
      clid: '1',
      ctid: '1',
      clientDatabaseId: '2',
      clientUniqueIdentifier: 'u',
      clientNickname: 'n',
      clientType: 1,
      clientCountry: '',
    });
    expect(minimal).toMatchObject({ serverGroups: [], country: undefined, away: false });
  });
});

describe('attachNotificationHandlers', () => {
  function setup() {
    const teamspeak = new TeamSpeak({ autoConnect: false });
    const query = (teamspeak as unknown as { query: EventEmitter }).query;
    const clientList = vi.spyOn(teamspeak, 'clientList');
    const channelList = vi.spyOn(teamspeak, 'channelList');
    const target = new EventEmitter<Ts3TransportEvents>();
    attachNotificationHandlers(teamspeak, target, 99);
    return { query, clientList, channelList, target };
  }

  it('emits events from notifications without sending extra commands (rule 5)', () => {
    const { query, clientList, channelList, target } = setup();
    const events: unknown[] = [];
    target.on('clientConnect', (c) => events.push(['connect', c.uid, c.channelId]));
    target.on('clientMoved', (e) => events.push(['moved', e.clid, e.channelId]));
    target.on('clientDisconnect', (e) => events.push(['left', e.clid, e.reasonId]));

    query.emit('cliententerview', enterView);
    query.emit('clientmoved', { clid: '12', ctid: '7', reasonid: '0' });
    query.emit('clientleftview', { clid: '12', reasonid: '8', cfid: '7', ctid: '0' });

    expect(events).toEqual([
      ['connect', 'abcDEF123+/=', 5],
      ['moved', 12, 7],
      ['left', 12, 8],
    ]);
    expect(clientList).not.toHaveBeenCalled();
    expect(channelList).not.toHaveBeenCalled();
  });

  it('removes the library handlers for these notifications', () => {
    const { query } = setup();
    expect(query.listenerCount('cliententerview')).toBe(1);
    expect(query.listenerCount('clientleftview')).toBe(1);
    expect(query.listenerCount('clientmoved')).toBe(1);
    expect(query.listenerCount('textmessage')).toBe(1);
    expect(query.listenerCount('channelcreated')).toBe(1);
    expect(query.listenerCount('channeldeleted')).toBe(1);
    // Nothing of ours listens to these, and the library must not fetch lists for them either.
    for (const name of ['channeledited', 'channelmoved', 'serveredited', 'tokenused']) {
      expect(query.listenerCount(name)).toBe(0);
    }
  });

  it('tells whether a client switched itself or was moved', () => {
    const { query, target } = setup();
    const events: unknown[] = [];
    target.on('clientMoved', (e) => events.push(e));
    query.emit('clientmoved', { clid: '12', ctid: '7', reasonid: '0' });
    query.emit('clientmoved', { clid: '12', ctid: '8', reasonid: '1', invokerid: '3' });
    expect(events).toEqual([
      { clid: 12, channelId: 7, reasonId: 0, invokerClid: undefined },
      { clid: 12, channelId: 8, reasonId: 1, invokerClid: 3 },
    ]);
  });

  it('passes on private messages, but not other chats or its own echo', () => {
    const { query, clientList, target } = setup();
    const events: unknown[] = [];
    target.on('textMessage', (e) => events.push(e));
    const message = { msg: 'akzeptieren', invokername: 'Alice', invokeruid: 'abcDEF123+/=' };
    query.emit('textmessage', { ...message, targetmode: 1, invokerid: '12' });
    query.emit('textmessage', { ...message, targetmode: 3, invokerid: '12' });
    query.emit('textmessage', { ...message, targetmode: 1, invokerid: '99' });
    expect(events).toEqual([
      { clid: 12, uid: 'abcDEF123+/=', nickname: 'Alice', message: 'akzeptieren' },
    ]);
    expect(clientList).not.toHaveBeenCalled();
  });

  it('reports created and deleted channels without fetching lists', () => {
    const { query, clientList, channelList, target } = setup();
    const events: unknown[] = [];
    target.on('channelCreated', (e) => events.push(e));
    target.on('channelDeleted', (e) => events.push(e));
    const created = { cid: '40', cpid: '5', invokerid: '12', invokeruid: 'abcDEF123+/=' };
    query.emit('channelcreated', { ...created, channelName: 'Mein Raum' });
    query.emit('channelcreated', { ...created, channelName: 'Fest', channelFlagPermanent: true });
    query.emit('channelcreated', { ...created, channelName: 'Halb', channelFlagSemiPermanent: 1 });
    query.emit('channeldeleted', { cid: '40', invokerid: '0' });
    expect(events).toEqual([
      {
        cid: 40,
        pid: 5,
        name: 'Mein Raum',
        kind: 'temporary',
        invokerClid: 12,
        invokerUid: 'abcDEF123+/=',
      },
      expect.objectContaining({ name: 'Fest', kind: 'permanent' }),
      expect.objectContaining({ name: 'Halb', kind: 'semi' }),
      { cid: 40, invokerClid: 0 },
    ]);
    expect(clientList).not.toHaveBeenCalled();
    expect(channelList).not.toHaveBeenCalled();
  });
});

describe('channel mapping', () => {
  it('maps a channel of the list with occupancy, limit and kind', () => {
    const channel = {
      cid: '40',
      pid: '5',
      name: 'Talk 1',
      order: 39,
      totalClients: 2,
      maxclients: -1,
      flagPermanent: false,
      flagSemiPermanent: true,
      flagPassword: true,
    };
    expect(toTs3Channel(channel)).toEqual({
      cid: 40,
      pid: 5,
      name: 'Talk 1',
      order: 39,
      totalClients: 2,
      maxClients: -1,
      kind: 'semi',
      hasPassword: true,
    });
  });

  it('builds the parameters of a new channel', () => {
    expect(channelCreateProps({ name: 'Talk 1', parentId: 5, kind: 'permanent' })).toEqual({
      channelName: 'Talk 1',
      cpid: 5,
      channelFlagPermanent: true,
    });
    expect(
      channelCreateProps({
        name: 'Privat',
        parentId: 5,
        kind: 'temporary',
        order: 39,
        deleteDelayS: 600,
        topic: 't',
        description: 'd',
        maxClients: 4,
        codecQuality: 7,
        password: 'geheim',
        encrypted: true,
      }),
    ).toEqual({
      channelName: 'Privat',
      cpid: 5,
      channelOrder: 39,
      channelDeleteDelay: 600,
      channelTopic: 't',
      channelDescription: 'd',
      channelFlagMaxclientsUnlimited: false,
      channelMaxclients: 4,
      channelCodecQuality: 7,
      channelPassword: 'geheim',
      channelCodecIsUnencrypted: false,
    });
  });

  it('only sends a delete delay for temporary channels and no empty password', () => {
    const props = channelCreateProps({
      name: 'Halb',
      parentId: 0,
      kind: 'semi',
      deleteDelayS: 600,
      password: '',
      maxClients: -1,
    });
    expect(props).toEqual({
      channelName: 'Halb',
      cpid: 0,
      channelFlagSemiPermanent: true,
      channelFlagMaxclientsUnlimited: true,
    });
  });

  it('only sends the fields of an edit that were given', () => {
    expect(channelEditProps({})).toEqual({});
    expect(channelEditProps({ name: 'Support [zu]', maxClients: 0, password: '' })).toEqual({
      channelName: 'Support [zu]',
      channelFlagMaxclientsUnlimited: false,
      channelMaxclients: 0,
      channelPassword: '',
    });
  });
});

type RawBan = Awaited<ReturnType<Parameters<typeof fetchAllBans>[0]>>[number];

describe('fetchAllBans', () => {
  const raw = (id: number): RawBan => ({
    banid: String(id),
    ip: id === 1 ? '203.0.113.9' : '',
    name: '',
    uid: id === 2 ? 'uid-2=' : '',
    mytsid: '',
    lastnickname: 'Troll',
    created: 1_789_000_000,
    duration: 3600,
    invokername: 'Admin',
    invokercldbid: '1',
    invokeruid: 'admin=',
    reason: '',
    enforcements: 4,
  });

  it('maps entries and turns empty strings into undefined', async () => {
    const bans = await fetchAllBans(() => Promise.resolve([raw(1), raw(2)]));
    expect(bans).toEqual([
      {
        banId: 1,
        ip: '203.0.113.9',
        name: undefined,
        uid: undefined,
        lastNickname: 'Troll',
        reason: undefined,
        invokerName: 'Admin',
        invokerUid: 'admin=',
        createdAt: 1_789_000_000,
        durationS: 3600,
        enforcements: 4,
      },
      expect.objectContaining({ banId: 2, ip: undefined, uid: 'uid-2=' }),
    ]);
  });

  it('reads further pages while they are full', async () => {
    const fetchPage = vi.fn((start: number) =>
      Promise.resolve(
        start === 0 ? Array.from({ length: 1000 }, (_, i) => raw(i + 10)) : [raw(5000)],
      ),
    );
    const bans = await fetchAllBans(fetchPage);
    expect(bans).toHaveLength(1001);
    expect(fetchPage.mock.calls).toEqual([
      [0, 1000],
      [1000, 1000],
    ]);
  });

  it('treats error 1281 as an empty list and rethrows other errors', async () => {
    const empty = new ResponseError({ id: '1281', msg: 'database empty result set' }, '');
    await expect(fetchAllBans(() => Promise.reject(empty))).resolves.toEqual([]);
    const denied = new ResponseError({ id: '2568', msg: 'insufficient client permissions' }, '');
    await expect(fetchAllBans(() => Promise.reject(denied))).rejects.toBe(denied);
  });
});
