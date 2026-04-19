import { EventEmitter } from 'events';

// Class to ratelimit a resource (chatting, logging in, etc)
export default class RateLimiter extends EventEmitter {
	private limit: number;
	private interval: number;
	private requestCount: number;
	private limiter?: NodeJS.Timeout;
	constructor(limit: number, interval: number) {
		super();
		this.limit = limit;
		this.interval = interval;
		this.requestCount = 0;
	}
	// Return value is whether or not the action should be continued
	request(): boolean {
		if (!this.limiter) {
			this.limiter = setTimeout(() => {
				this.clearWindow();
			}, this.interval * 1000);
		}

		this.requestCount++;
		if (this.requestCount >= this.limit) {
			this.emit('limit');
			this.clearWindow();
			return false;
		}

		return true;
	}

	private clearWindow(): void {
		if (this.limiter) {
			clearTimeout(this.limiter);
			this.limiter = undefined;
		}
		this.requestCount = 0;
	}
}
