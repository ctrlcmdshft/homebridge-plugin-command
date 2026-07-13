const { execSync } = require('child_process');

const PLUGIN_IDENTIFIER = 'homebridge-shell-command';
const ACCESSORY_NAME = 'Shell Command';

module.exports = function(api) {
  api.registerAccessory(PLUGIN_IDENTIFIER, ACCESSORY_NAME, CommandAccessoryPlugin);
};

function durationSeconds(timeExpr) {
  if (!isNaN(timeExpr)) {
    return parseInt(timeExpr, 10);
  }
  var units = { 'd': 86400, 'h': 3600, 'm': 60, 's': 1 };
  var regex = /(\d+)([dhms])/g;

  let seconds = 0;
  var match;
  while ((match = regex.exec(timeExpr))) {
    seconds += parseInt(match[1], 10) * units[match[2]];
  }

  return seconds;
}

class CommandAccessoryPlugin {
  constructor(log, config, api) {
    this.log = log;
    this.config = config;
    this.api = api;
    this.currentState = false;
    this.name = config.name || ACCESSORY_NAME;
    this.invertStatus = Boolean(config.invert_status);
    this.logCommandFailures = config.log_command_failures !== false;
    this.commandTimeoutMs = undefined;

    if (config.command_timeout) {
      const secs = durationSeconds(config.command_timeout);
      if (isNaN(secs) || secs < 1) {
        this.log.error('Invalid command_timeout, ignoring (commands will not be timed out).');
      } else {
        this.commandTimeoutMs = secs * 1000;
      }
    }

    // your accessory must have an AccessoryInformation service
    this.informationService = new this.api.hap.Service.AccessoryInformation()
      .setCharacteristic(this.api.hap.Characteristic.Manufacturer, 'ctrlcmdshft')
      .setCharacteristic(this.api.hap.Characteristic.SerialNumber, '#007')
      .setCharacteristic(this.api.hap.Characteristic.Model, this.name);

    // create a new "Switch" service
    this.switchService = new this.api.hap.Service.Switch(this.name);

    // link methods used when getting or setting the state of the service 
    this.switchService.getCharacteristic(this.api.hap.Characteristic.On)
      .onGet(this.getState.bind(this))   // bind to getStateHandler method below
      .onSet(this.setState.bind(this));  // bind to setStateHandler method below

    if (this.config.check_status && this.config.poll_check) {
      let secs = durationSeconds(this.config.poll_check);
      if (isNaN(secs) || secs < 1) {
        this.log.error('Too frequent or incorrect poll check time, polling disabled.');
      } else {
        this.log.info(`Setting poll interval to ${secs}s`);
        this.interval = setInterval(async () => {
          this.log.debug('Polling status');
          const oldState = this.currentState;
          if (await this.getState(secs * 1000) !== oldState) {
            this.log.debug('Updating state');
            this.switchService.getCharacteristic(this.api.hap.Characteristic.On)
              .updateValue(this.currentState);
          }
          this.log.debug('Polling done');
        }, secs * 1000);

        this.interval.unref?.();
      }
    }

    this.api.on('shutdown', () => {
      if (this.interval) {
        clearInterval(this.interval);
        this.interval = undefined;
      }
    });

    this.log.info('Shell Command Plugin Loaded');
  }

  getServices() {
    return [
      this.informationService,
      this.switchService,
    ];
  }

  logCommandFailure(cmd, error, { warn = false } = {}) {
    const level = warn && this.logCommandFailures ? 'warn' : 'debug';

    if (error.killed || error.signal === 'SIGTERM') {
      this.log[level](`Command timed out: ${cmd}`);
      return;
    }
    const stderr = error.stderr ? error.stderr.toString().trim() : '';
    this.log[level](`Command failed: ${cmd} (exit code ${error.status}); ${stderr || error.message}`);
  }

  async getState(timeout = this.commandTimeoutMs) {
    this.log.debug(`Getting switch state`);

    if (!this.config.check_status) {
      this.log.debug(`No check_status, returning static state: ${this.currentState}`);
      return this.currentState;
    }

    this.log.debug(`Running: ${this.config.check_status}`);

    try {
      execSync(this.config.check_status, { timeout: timeout });
      this.currentState = !this.invertStatus;
    } catch (error) {
      this.logCommandFailure(this.config.check_status, error);
      this.currentState = this.invertStatus;
    }

    this.log.debug(`Returning: ${this.currentState}`);
    return this.currentState;
  }

  async setState(value) {
    this.log.debug(`Setting switch state to: ${value}`);

    const cmd = value ? this.config.turn_on : this.config.turn_off;

    if (!cmd) {
      this.currentState = value;
      this.log.warn(`No command configured for state ${value ? 'on' : 'off'}; updating switch state only.`);
      return this.currentState;
    }

    let exitCode = 1;
    this.log.debug(`Running: ${cmd}`);
    try {
      execSync(cmd, { timeout: this.commandTimeoutMs });
      exitCode = 0;
    } catch (error) {
      this.logCommandFailure(cmd, error, { warn: true });
      exitCode = 1;
    }

    // Set state depending on whether the command exited successfully or not.
    this.currentState = Boolean(value ^ (exitCode !== 0));
    this.log.debug(`Returning: ${this.currentState}`);
    return this.currentState;
  }
}
