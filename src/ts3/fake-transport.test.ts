import { beforeEach, describe, expect, it } from 'vitest';
import { FAKE_BOT_CLID, FakeTs3Server, type FakeTs3Transport } from './fake-transport.js';
import { MOVE_REASON_CHANNEL_KICK, MOVE_REASON_MOVED, MOVE_REASON_SELF } from './types.js';

let server: FakeTs3Server;
let transport: FakeTs3Transport;

beforeEach(async () => {
  server = new FakeTs3Server(() => 0);
  server.addChannel(2, 'Gaming');
  transport = server.createTransport();
  await transport.connect();
});

const names = async () => (await transport.channelList()).map((c) => c.name);

describe('fake channels', () => {
  it('reports the occupancy of every channel, the bot included', async () => {
    const clid = server.join({ uid: 'a', nickname: 'A' });
    server.join({ uid: 'b', nickname: 'B', channelId: 2 });
    server.move(clid, 2);
    const channels = await transport.channelList();
    expect(channels.find((c) => c.cid === 1)?.totalClients).toBe(1);
    expect(channels.find((c) => c.cid === 2)?.totalClients).toBe(2);
  });

  it('creates a channel with its settings and announces it', async () => {
    const created: unknown[] = [];
    transport.on('channelCreated', (event) => created.push(event));
    const cid = await transport.channelCreate({
      name: 'Talk 1',
      parentId: 2,
      kind: 'permanent',
      maxClients: 5,
      description: 'Hallo',
      password: 'geheim',
    });
    expect((await transport.channelList()).find((c) => c.cid === cid)).toEqual({
      cid,
      pid: 2,
      name: 'Talk 1',
      order: 0,
      totalClients: 0,
      maxClients: 5,
      kind: 'permanent',
      hasPassword: true,
    });
    expect(server.channelDetails.get(cid)).toEqual({ description: 'Hallo', password: 'geheim' });
    expect(created).toEqual([
      {
        cid,
        pid: 2,
        name: 'Talk 1',
        kind: 'permanent',
        invokerClid: FAKE_BOT_CLID,
        invokerUid: 'serveradmin',
      },
    ]);
  });

  it('refuses a second channel with the same name below the same parent', async () => {
    await transport.channelCreate({ name: 'Talk 1', parentId: 2, kind: 'permanent' });
    expect(() =>
      transport.channelCreate({ name: 'Talk 1', parentId: 2, kind: 'permanent' }),
    ).toThrow(/already in use/);
    await transport.channelCreate({ name: 'Talk 1', parentId: 0, kind: 'permanent' });
    expect(() => transport.channelCreate({ name: 'X', parentId: 77, kind: 'permanent' })).toThrow(
      /invalid channelID/,
    );
  });

  it('edits name, limit, description and password', async () => {
    const cid = await transport.channelCreate({ name: 'Support', parentId: 0, kind: 'permanent' });
    await transport.channelEdit(cid, {
      name: 'Support [offen]',
      maxClients: 10,
      description: 'Wir sind da',
      password: 'x',
    });
    await transport.channelEdit(cid, { password: '' });
    const channel = (await transport.channelList()).find((c) => c.cid === cid);
    expect(channel).toMatchObject({ name: 'Support [offen]', maxClients: 10, hasPassword: false });
    expect(server.channelDetails.get(cid)).toEqual({ description: 'Wir sind da' });
    expect(() => transport.channelEdit(cid, { name: 'Gaming' })).toThrow(/already in use/);
  });

  it('deletes an occupied channel only when forced', async () => {
    const deleted: unknown[] = [];
    transport.on('channelDeleted', (event) => deleted.push(event));
    const cid = await transport.channelCreate({ name: 'Talk 1', parentId: 0, kind: 'permanent' });
    const clid = server.join({ uid: 'a', nickname: 'A', channelId: cid });
    expect(() => transport.channelDelete(cid, false)).toThrow(/not empty/);
    await transport.channelDelete(cid, true);
    expect(await names()).toEqual(['Lobby', 'Gaming']);
    expect(server.clients.get(clid)?.channelId).toBe(1);
    expect(deleted).toEqual([{ cid, invokerClid: FAKE_BOT_CLID }]);
  });

  it('pulls the bot into a temporary channel and drops it once everybody left', async () => {
    const clid = server.join({ uid: 'a', nickname: 'A' });
    const cid = await transport.channelCreate({ name: 'Privat', parentId: 0, kind: 'temporary' });
    expect(await transport.self()).toEqual({ clid: FAKE_BOT_CLID, channelId: cid });

    await transport.move(clid, cid);
    await transport.move(FAKE_BOT_CLID, 1);
    expect(await names()).toContain('Privat');

    server.move(clid, 1);
    expect(await names()).not.toContain('Privat');
  });

  it('keeps an empty temporary channel that has a delete delay', async () => {
    await transport.channelCreate({
      name: 'Privat',
      parentId: 0,
      kind: 'temporary',
      deleteDelayS: 3600,
    });
    await transport.move(FAKE_BOT_CLID, 1);
    expect(await names()).toContain('Privat');
  });

  it('lets a client create its own temporary channel', async () => {
    const created: unknown[] = [];
    transport.on('channelCreated', (event) => created.push(event));
    const clid = server.join({ uid: 'uid-a', nickname: 'A' });
    const cid = server.createChannelAs(clid, 'Mein Raum');
    expect(created).toMatchObject([
      { cid, kind: 'temporary', invokerClid: clid, invokerUid: 'uid-a' },
    ]);
    expect(server.clients.get(clid)?.channelId).toBe(cid);
    server.leave(clid);
    expect(await names()).not.toContain('Mein Raum');
  });

  it('stores channel permissions and channel groups', async () => {
    const cid = await transport.channelCreate({ name: 'Talk 1', parentId: 0, kind: 'permanent' });
    await transport.channelSetPermission(cid, 'i_channel_needed_join_power', 10);
    await transport.channelSetPermission(cid, 'i_client_needed_talk_power', 0);
    await transport.setChannelGroup(101, cid, 5);
    expect(server.channelPermissions.get(cid)).toEqual({
      i_channel_needed_join_power: 10,
      i_client_needed_talk_power: 0,
    });
    expect(server.channelGroupAssignments).toEqual([{ dbid: 101, cid, groupId: 5 }]);
    expect(() => transport.setChannelGroup(101, cid, 99)).toThrow(/invalid group/);
    expect((await transport.channelGroups()).map((g) => g.name)).toEqual([
      'Channel Admin',
      'Guest',
    ]);
  });
});

describe('fake moves and messages', () => {
  it('tells who moved a client', async () => {
    const moves: unknown[] = [];
    transport.on('clientMoved', (event) => moves.push(event));
    const clid = server.join({ uid: 'a', nickname: 'A' });
    const admin = server.join({ uid: 'b', nickname: 'B' });

    server.move(clid, 2);
    server.move(clid, 1, admin);
    await transport.move(clid, 2);
    await transport.kick(clid, 'channel', 'raus');

    expect(moves).toEqual([
      { clid, channelId: 2, reasonId: MOVE_REASON_SELF, invokerClid: undefined },
      { clid, channelId: 1, reasonId: MOVE_REASON_MOVED, invokerClid: admin },
      { clid, channelId: 2, reasonId: MOVE_REASON_MOVED, invokerClid: FAKE_BOT_CLID },
      { clid, channelId: 1, reasonId: MOVE_REASON_CHANNEL_KICK, invokerClid: FAKE_BOT_CLID },
    ]);
  });

  it('delivers a private message to the bot', () => {
    const messages: unknown[] = [];
    transport.on('textMessage', (event) => messages.push(event));
    const clid = server.join({ uid: 'uid-a', nickname: 'A' });
    server.privateMessage(clid, 'akzeptieren');
    expect(messages).toEqual([{ clid, uid: 'uid-a', nickname: 'A', message: 'akzeptieren' }]);
  });

  it('lists the members of a server group, empty when it has none', async () => {
    server.groupMembers.set(6, [{ dbid: 101, uid: 'uid-a', nickname: 'A' }]);
    expect(await transport.serverGroupMembers(6)).toEqual([
      { dbid: 101, uid: 'uid-a', nickname: 'A' },
    ]);
    expect(await transport.serverGroupMembers(8)).toEqual([]);
  });
});
