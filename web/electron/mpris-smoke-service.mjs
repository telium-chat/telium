import * as dbus from '@jellybrick/dbus-next';

const SERVICE = 'org.mpris.MediaPlayer2.teliumsmoke';
const PATH = '/org/mpris/MediaPlayer2';
const ROOT = 'org.mpris.MediaPlayer2';
const PLAYER = 'org.mpris.MediaPlayer2.Player';
const PROPERTIES = 'org.freedesktop.DBus.Properties';
const INTROSPECTABLE = 'org.freedesktop.DBus.Introspectable';

const XML = `<!DOCTYPE node PUBLIC "-//freedesktop//DTD D-BUS Object Introspection 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/introspect.dtd">
<node>
  <interface name="org.freedesktop.DBus.Introspectable">
    <method name="Introspect"><arg name="xml_data" type="s" direction="out"/></method>
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
    <signal name="Seeked"><arg name="Position" type="x"/></signal>
  </interface>
</node>`;

const metadata = () => ({
  'xesam:title': new dbus.Variant('s', 'Packaged MPRIS Smoke'),
  'xesam:artist': new dbus.Variant('as', ['Telium CI']),
  'xesam:album': new dbus.Variant('s', 'AppImage'),
  'mpris:length': new dbus.Variant('x', 180_000_000n),
  'mpris:artUrl': new dbus.Variant('s', 'https://covers.example/packaged-smoke.jpg'),
});

const bus = dbus.sessionBus();
bus.on('error', (error) => {
  console.error('[Telium MPRIS smoke service]', error);
  process.exitCode = 2;
});

bus.addMethodHandler((message) => {
  if (message.path !== PATH) return false;
  if (message.interface === INTROSPECTABLE && message.member === 'Introspect') {
    bus.send(dbus.Message.newMethodReturn(message, 's', [XML]));
    return true;
  }
  if (message.interface !== PROPERTIES) return false;

  if (message.member === 'GetAll') {
    const iface = message.body?.[0];
    if (iface === ROOT) {
      bus.send(dbus.Message.newMethodReturn(message, 'a{sv}', [{
        Identity: new dbus.Variant('s', 'Telium MPRIS Smoke Player'),
      }]));
      return true;
    }
    if (iface === PLAYER) {
      bus.send(dbus.Message.newMethodReturn(message, 'a{sv}', [{
        PlaybackStatus: new dbus.Variant('s', 'Playing'),
        Metadata: new dbus.Variant('a{sv}', metadata()),
      }]));
      return true;
    }
  }

  if (message.member === 'Get'
    && message.body?.[0] === PLAYER
    && message.body?.[1] === 'Position') {
    bus.send(dbus.Message.newMethodReturn(message, 'v', [
      new dbus.Variant('x', 45_000_000n),
    ]));
    return true;
  }
  return false;
});

await bus.requestName(SERVICE);
console.info('telium-mpris-smoke-service=ready');

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await bus.releaseName(SERVICE).catch(() => {});
  bus.disconnect();
};
process.on('SIGTERM', () => { void stop().finally(() => process.exit(0)); });
process.on('SIGINT', () => { void stop().finally(() => process.exit(0)); });
