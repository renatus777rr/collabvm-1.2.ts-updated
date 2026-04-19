import EventEmitter from 'events';
import VM from './interface.js';
import { QemuVM, QemuVmDefinition, VMState } from '@computernewb/superqemu';
import { VMDisplay } from '../display/interface.js';
import { VncDisplay } from '../display/vnc.js';
import pino from 'pino';
import { CgroupLimits, QemuResourceLimitedLauncher } from './qemu_launcher.js';

// shim over superqemu because it diverges from the VM interface
export class QemuVMShim implements VM {
	private vm: QemuVM;
	private display: VncDisplay | null = null;
	private logger: pino.Logger;
	private cg_launcher: QemuResourceLimitedLauncher | null = null;
	private resource_limits: CgroupLimits | null = null;

	constructor(def: QemuVmDefinition, resourceLimits?: CgroupLimits) {
		this.logger = pino({ name: `CVMTS.QemuVMShim/${def.id}` });

		if (resourceLimits) {
			if (process.platform === 'linux') {
				this.resource_limits = resourceLimits;
				this.cg_launcher = new QemuResourceLimitedLauncher(def.id, resourceLimits);
				this.vm = new QemuVM(def, this.cg_launcher);
			} else {
				// Just use the default Superqemu launcher on non-Linux platforms,
				// .. regardless of if resource control is (somehow) enabled.
				this.logger.warn({ platform: process.platform }, 'Resource control is not supported on this platform. Please remove or comment it out from your configuration.');
				this.vm = new QemuVM(def);
			}
		} else {
			this.vm = new QemuVM(def);
		}

		this.vm.on('statechange', async (newState) => {
			if (newState === VMState.Started) {
				await this.PlaceVCPUThreadsIntoCGroup();
			}
		});
	}

	Start(): Promise<void> {
		return this.vm.Start();
	}

	async Stop(): Promise<void> {
		await this.vm.Stop();

		this.display?.Disconnect();
		this.display = null;
	}

	Reboot(): Promise<void> {
		return this.vm.Reboot();
	}

	Reset(): Promise<void> {
		return this.vm.Reset();
	}

	MonitorCommand(command: string): Promise<unknown> {
		return this.vm.MonitorCommand(command);
	}

	async PlaceVCPUThreadsIntoCGroup() {
		let pin_vcpu_threads = false;
		if (this.cg_launcher) {
			// messy as all hell but oh well
			if (this.resource_limits?.limitProcess === undefined) {
				pin_vcpu_threads = true;
			} else {
				pin_vcpu_threads = !this.resource_limits?.limitProcess;
			}

			if (pin_vcpu_threads) {
				// Get all vCPUs and pin them to the CGroup.
				const cpu_res = await this.vm.QmpCommand('query-cpus-fast', {});
				for (const cpu of cpu_res) {
					this.logger.info(`Placing vCPU thread with TID ${cpu['thread-id']} to cgroup`);
					this.cg_launcher.group.AttachThread(cpu['thread-id']);
				}
			}
		}
	}

	StartDisplay(): void {
		// boot it up
		const info = this.vm.GetDisplayInfo();

		if (info === null) throw new Error('display info unavailable');

		switch (info.type) {
			case 'vnc-tcp':
				this.display = new VncDisplay({
					host: info.host || '127.0.0.1',
					port: info.port || 5900,
					path: null
				});
				break;
			case 'vnc-uds':
				this.display = new VncDisplay({
					path: info.path
				});
				break;
		}

		this.display?.on('connected', () => {
			this.logger.info('Display connected');
		});

		this.display?.Connect();
	}

	GetDisplay(): VMDisplay | null {
		return this.display;
	}

	GetState(): VMState {
		return this.vm.GetState();
	}

	SnapshotsSupported(): boolean {
		return this.vm.SnapshotsSupported();
	}

	Events(): EventEmitter {
		return this.vm;
	}
}
