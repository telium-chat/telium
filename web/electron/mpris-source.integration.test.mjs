import assert from 'node:assert/strict';
import test from 'node:test';
import * as dbus from '@jellybrick/dbus-next';
import { createMprisSource } from './mpris-source.mjs';

const SERVICE = 'org.mpris.MediaPlayer2.teliumtest';
const PATH = '/org/mpris/MediaPlayer2';
const ROOT = 'org.mpris.MediaPlayer2';
const PLAYER = 'org.mpris.MediaPlayer2.Player';
const PROPERTIES = 'org.freedesktop.DBus.Properties';
const INTROSPECTABLE = 'org.freedesktop.DBus.Introspectable';

const XML = `<!DOCTYPE node PUBLIC "-//freedesktop//DTD D-BUS Object Introspection 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/introspect.dtd">
<node>
  <interface name="org.freedesktop.DBus.Introspectable">
    <method name="Introspect">
      <arg name="xml_data" type="s" direction="out"/>
    </method>
  </interface>
  <interface name="org.freedesktop.DBus.Properties">
    <method name="Get">
      <arg name="interface_name" type="s" direction="in"/>
      <arg name="property_name" type="s" direction="in"/>
      <arg name="value" type="v" direction="out"/>
    </method>
    <method name="GetAll">
      <arg name="interface_name" type="s" direction="in"/>
      <arg name="props" type="a{sv}" direction="out"/>
    </method>
    <signal name="PropertiesChanged">
      <arg name="interface_name" type="s"/>
      <arg name="changed_properties" type="a{sv}"/>
      <arg name="invalidated_properties" type="as"/>
    </signal>
  </interface>
  <interface name="org.mpris.MediaPlayer2">
    <property name="Identity" type="s" access="read"/>
  </interface>
  <interface name="org.mpris.MediaPlayer2.Player">
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="Position" type="x" access="read"/>
    <signal name="Seeked">
      <arg name="Position" type="x"/>
    </signal>
  </interface>
</node>`;

function metadata() {
  return {
    'xesam:title': new dbus.Variant('s', 'Telium Integration Song'),
    'xesam:artist': new dbus.Variant('as', ['Telium Test Artist']),
    'xesam:album': new dbus.Variant('s', 'Telium Test Album'),
    'mpris:length': new dbus.Variant('x', 180_000_000n),
    'mpris:artUrl': new dbus.Variant('s', 'https://covers.example/integration.jpg'),
  };
}

test('discovers an actual MPRIS service through a real session D-Bus', async (t) => {
  if (!process.env.DBUS_SESSION_BUS_ADDRESS) {
    t.skip('run this test under dbus-run-session');
    return;
  }

  const serviceBus = dbus.sessionBus();
  serviceBus.on('error', (error) => {
    // Fail via the assertions, not an uncaught EventEmitter error.
    console.error('[MPRIS integration service]', error);
  });

  serviceBus.addMethodHandler((message) => {
    if (message.path !== PATH) return false;

    if (message.interface === INTROSPECTABLE && message.member === 'Introspect') {
      serviceBus.send(dbus.Message.newMethodReturn(message, 's', [XML]));
      return true;
    }

    if (message.interface !== PROPERTIES) return false;
    if (message.member === 'GetAll') {
      const iface = message.body?.[0];
      if (iface === ROOT) {
        serviceBus.send(dbus.Message.newMethodReturn(message, 'a{sv}', [{
          Identity: new dbus.Variant('s', 'Telium Test Player'),
        }]));
        return true;
      }
      if (iface === PLAYER) {
        serviceBus.send(dbus.Message.newMethodReturn(message, 'a{sv}', [{
          PlaybackStatus: new dbus.Variant('s', 'Playing'),
          Metadata: new dbus.Variant('a{sv}', metadata()),
        }]));
        return true;
      }
    }

    if (message.member === 'Get'
      && message.body?.[0] === PLAYER
      && message.body?.[1] === 'Position') {
      serviceBus.send(dbus.Message.newMethodReturn(message, 'v', [
        new dbus.Variant('x', 45_000_000n),
      ]));
      return true;
    }
    return false;
  });

  await serviceBus.requestName(SERVICE);

  const activities = [];
  const statuses = [];
  const errors = [];
  const source = createMprisSource({
    onActivity: (entry) => activities.push(entry),
    onStatus: (status) => statuses.push(status),
    onError: (error) => errors.push(error),
  });

  try {
    assert.equal(await source.start(), true);
    assert.equal(errors.length, 0);
    assert.equal(activities.at(-1)?.key, SERVICE);
    assert.equal(activities.at(-1)?.activity?.name, 'Telium Test Player');
    assert.equal(activities.at(-1)?.activity?.details, 'Telium Integration Song');
    assert.equal(activities.at(-1)?.activity?.state, 'Telium Test Artist');
    assert.equal(statuses.at(-1)?.available, true);
    assert.equal(statuses.at(-1)?.players, 1);
    assert.equal(statuses.at(-1)?.readable, 1);
    assert.equal(statuses.at(-1)?.playing, 1);
    assert.deepEqual(statuses.at(-1)?.names, ['Telium Test Player']);
  } finally {
    await source.stop();
    await serviceBus.releaseName(SERVICE).catch(() => {});
    serviceBus.disconnect();
  }
});
