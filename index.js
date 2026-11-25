'use strict';

const { DeakoClient } = require('./lib/client');

const PLUGIN_NAME = 'homebridge-deako';
const PLATFORM_NAME = 'Deako';

module.exports = (api) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, DeakoPlatform);
};

class DeakoPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.accessories = new Map(); // HomeKit UUID -> PlatformAccessory
    this.seen = new Set();

    if (!this.config.host) {
      log.error('Set "host" to the IP address of your Deako hub (the device that runs the local integration).');
      return;
    }

    this.client = new DeakoClient({ host: this.config.host, port: this.config.port || 23 });
    this.client.on('connected', () => log.info(`Connected to Deako hub at ${this.config.host}`));
    this.client.on('disconnected', () => log.warn('Disconnected from Deako hub; reconnecting'));
    this.client.on('error', (err) => log.warn(`Deako hub error: ${err.message}`));
    this.client.on('device', (device) => this.upsert(device));
    this.client.on('state', (id, state) => this.applyState(id, state));

    api.on('didFinishLaunching', () => {
      this.client.start();
      // Remove cached lights that the hub no longer reports.
      setTimeout(() => this.pruneStale(), 30000);
    });
    api.on('shutdown', () => this.client.stop());
  }

  configureAccessory(accessory) {
    this.accessories.set(accessory.UUID, accessory);
    this.bind(accessory);
  }

  homekitUuid(deakoId) {
    return this.api.hap.uuid.generate(`deako:${deakoId}`);
  }

  upsert({ uuid: id, name, capabilities, state }) {
    const { Service, Characteristic } = this.api.hap;
    const uuid = this.homekitUuid(id);
    this.seen.add(uuid);

    let accessory = this.accessories.get(uuid);
    const dimmable = capabilities.includes('dim');
    if (!accessory) {
      accessory = new this.api.platformAccessory(name, uuid);
      accessory.context = { id, name, dimmable };
      accessory.addService(Service.Lightbulb, name);
      this.bind(accessory);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.set(uuid, accessory);
      this.log.info(`Added ${name}${dimmable ? ' (dimmer)' : ''}`);
    } else if (accessory.context.dimmable !== dimmable || accessory.context.name !== name) {
      accessory.context = { id, name, dimmable };
      this.bind(accessory);
      this.api.updatePlatformAccessories([accessory]);
    }

    accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'Deako')
      .setCharacteristic(Characteristic.Model, dimmable ? 'Dimmer' : 'Switch')
      .setCharacteristic(Characteristic.SerialNumber, id);

    this.applyState(id, state);
  }

  bind(accessory) {
    const { Service, Characteristic } = this.api.hap;
    const service = accessory.getService(Service.Lightbulb) || accessory.addService(Service.Lightbulb, accessory.context.name);

    service.getCharacteristic(Characteristic.On).onSet((value) => {
      this.send(accessory, !!value, undefined);
    });

    if (accessory.context.dimmable) {
      service.getCharacteristic(Characteristic.Brightness).onSet((value) => {
        this.send(accessory, value > 0, value);
      });
    } else if (service.testCharacteristic(Characteristic.Brightness)) {
      service.removeCharacteristic(service.getCharacteristic(Characteristic.Brightness));
    }
  }

  send(accessory, power, dim) {
    const { HapStatusError, HAPStatus } = this.api.hap;
    this.log.debug(`${accessory.context.name}: power=${power}${dim !== undefined ? ` dim=${dim}` : ''}`);
    if (!this.client || !this.client.control(accessory.context.id, power, dim)) {
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  applyState(id, state) {
    const { Service, Characteristic } = this.api.hap;
    const accessory = this.accessories.get(this.homekitUuid(id));
    if (!accessory) return;
    const service = accessory.getService(Service.Lightbulb);
    if (typeof state.power === 'boolean') service.updateCharacteristic(Characteristic.On, state.power);
    if (accessory.context.dimmable && typeof state.dim === 'number') {
      service.updateCharacteristic(Characteristic.Brightness, state.dim);
    }
  }

  pruneStale() {
    if (!this.client || !this.client.connected || this.seen.size === 0) return;
    const stale = [...this.accessories.values()].filter((a) => !this.seen.has(a.UUID));
    if (stale.length === 0) return;
    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    stale.forEach((a) => {
      this.accessories.delete(a.UUID);
      this.log.info(`Removed ${a.displayName} (no longer reported by the hub)`);
    });
  }
}
