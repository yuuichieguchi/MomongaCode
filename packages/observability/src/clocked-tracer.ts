import { context as apiContext, trace } from '@opentelemetry/api';
import type {
  Attributes,
  Context,
  Exception,
  Link,
  Span,
  SpanContext,
  SpanOptions,
  SpanStatus,
  TimeInput,
  Tracer,
} from '@opentelemetry/api';
import { isTimeInput } from '@opentelemetry/core';
import type { Clock } from '@momonga/foundation';

class ClockedSpan implements Span {
  readonly #inner: Span;
  readonly #clock: Clock;

  constructor(inner: Span, clock: Clock) {
    this.#inner = inner;
    this.#clock = clock;
  }

  spanContext(): SpanContext {
    return this.#inner.spanContext();
  }

  setAttribute(key: string, value: Parameters<Span['setAttribute']>[1]): this {
    this.#inner.setAttribute(key, value);
    return this;
  }

  setAttributes(attributes: Attributes): this {
    this.#inner.setAttributes(attributes);
    return this;
  }

  addEvent(name: string, attributesOrStartTime?: Attributes | TimeInput, startTime?: TimeInput): this {
    if (isTimeInput(attributesOrStartTime)) {
      this.#inner.addEvent(name, attributesOrStartTime);
    } else {
      this.#inner.addEvent(name, attributesOrStartTime, startTime ?? this.#clock.now());
    }
    return this;
  }

  addLink(link: Link): this {
    this.#inner.addLink(link);
    return this;
  }

  addLinks(links: Link[]): this {
    this.#inner.addLinks(links);
    return this;
  }

  setStatus(status: SpanStatus): this {
    this.#inner.setStatus(status);
    return this;
  }

  updateName(name: string): this {
    this.#inner.updateName(name);
    return this;
  }

  end(endTime?: TimeInput): void {
    this.#inner.end(endTime ?? this.#clock.now());
  }

  isRecording(): boolean {
    return this.#inner.isRecording();
  }

  recordException(exception: Exception, time?: TimeInput): void {
    this.#inner.recordException(exception, time ?? this.#clock.now());
  }
}

class ClockedTracer implements Tracer {
  readonly #inner: Tracer;
  readonly #clock: Clock;

  constructor(inner: Tracer, clock: Clock) {
    this.#inner = inner;
    this.#clock = clock;
  }

  startSpan(name: string, options: SpanOptions = {}, parent?: Context): Span {
    const span = this.#inner.startSpan(name, { ...options, startTime: options.startTime ?? this.#clock.now() }, parent);
    return new ClockedSpan(span, this.#clock);
  }

  startActiveSpan<F extends (span: Span) => unknown>(name: string, fn: F): ReturnType<F>;
  startActiveSpan<F extends (span: Span) => unknown>(name: string, options: SpanOptions, fn: F): ReturnType<F>;
  startActiveSpan<F extends (span: Span) => unknown>(
    name: string,
    options: SpanOptions,
    parent: Context,
    fn: F,
  ): ReturnType<F>;
  startActiveSpan<F extends (span: Span) => unknown>(
    name: string,
    second: SpanOptions | F,
    third?: Context | F,
    fourth?: F,
  ): ReturnType<F> {
    const options = typeof second === 'function' ? {} : second;
    const parent = typeof third === 'function' || third === undefined ? apiContext.active() : third;
    const fn = typeof second === 'function' ? second : typeof third === 'function' ? third : fourth;
    if (fn === undefined) throw new TypeError('startActiveSpan requires a callback');
    const span = this.startSpan(name, options, parent);
    return apiContext.with(trace.setSpan(parent, span), () => fn(span)) as ReturnType<F>;
  }
}

export type { ClockedSpan, ClockedTracer };

export const createClockedTracer = (inner: Tracer, clock: Clock): ClockedTracer => new ClockedTracer(inner, clock);
