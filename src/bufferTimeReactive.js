import { Observable } from 'rxjs/Observable';
import { Subscriber } from 'rxjs/Subscriber';
import { isScheduler } from 'rxjs/util/isScheduler';
import { async } from 'rxjs/scheduler/async';

Observable.prototype.bufferTimeReactive = bufferTimeReactive;

function bufferTimeReactive(timeoutPeriod, scheduler) {

  scheduler = isScheduler(scheduler) ? scheduler : async;

  return this.lift(new BufferTimeReactiveOperator(timeoutPeriod, scheduler));
}

class BufferTimeReactiveOperator {
  constructor(timeoutPeriod, scheduler) {
    this.timeoutPeriod = timeoutPeriod;
    this.scheduler = scheduler;
  }

  call(subscriber, source) {
    return source.subscribe(new BufferTimeReactiveSubscriber(
      subscriber, this.timeoutPeriod, this.scheduler
    ));
  }
}

class BufferTimeReactiveSubscriber extends Subscriber {
  constructor(destination, timeoutPeriod, scheduler) {
    super(destination);
    this.timeoutPeriod = timeoutPeriod;
    this.scheduler = scheduler;
    this.buffer = [];

    this.timeout = null;

  }

  closeBuffer() {
    if (this.buffer) {
      this.destination.next(this.buffer);
    }

    if (!this.closed) {
      this.buffer = [];
    }
  }


  _next(value) {
    if (!this.timeout) {
      let timeoutState = { subscriber: this };
      this.timeout = this.scheduler.schedule(dispatchBufferTimeout, this.timeoutPeriod, timeoutState);
    }

    this.buffer.push(value);
  }

  _error(err) {
    this.buffer.length = 0;
    super._error(err);
  }

  _complete() {
    const { buffer, destination } = this;
    destination.next(buffer);
    super._complete();
  }

  _unsubscribe() {
    this.buffer = null;
  }
}

function dispatchBufferTimeout(state) {
  const { subscriber } = state;
  subscriber.timeout = null;

  if (subscriber.buffer) {
    subscriber.closeBuffer();
  }
}
