"use strict";

const P = require('bluebird');
const uuid = require('cassandra-uuid').TimeUuid;
const HTTPError = require('hyperswitch').HTTPError;
const URI = require('hyperswitch').URI;
const kafka = require('node-rdkafka');

const utils = require('./utils');

/**
 * The default number of tasks that could be run concurrently
 *
 * @type {number}
 * @const
 */
const DEFAULT_CONCURRENCY = 30;

/**
 * The default maximum delay to commit the offsets
 *
 * @const
 * @type {number}
 */
const DEFAULT_COMMIT_INTERVAL = 500;

class BaseExecutor {

    /**
     * Creates a new instance of a rule executor
     * @param {Rule} rule
     * @param {KafkaFactory} kafkaFactory
     * @param {Object} hyper
     * @param {Function} log
     * @param {Object} options
     * @class
     */
    constructor(rule, kafkaFactory, hyper, log, options) {
        if (this.constructor.name === 'BaseExecutor') {
            throw new Error('BaseService is abstract. Create Master or Worker instance.');
        }

        this.rule = rule;
        this.kafkaFactory = kafkaFactory;
        this.hyper = hyper;
        this.log = log;
        this.options = options;
        this.concurrency = rule.spec.concurrency || this.options.concurrency || DEFAULT_CONCURRENCY;

        this._commitTimeout = null;
        this._pendingMsgs = [];
        this._toCommit = undefined;
        this._consuming = false;
    }

    subscribe() {
        const prefix = this.options.test_mode ? `test-change-prop` : `change-prop`;
        return this.kafkaFactory.createConsumer(
            `${prefix}-${this.rule.name}`,
            this.subscribeTopic,
            this.hyper.metrics
        )
        .then((consumer) => {
            this.consumer = consumer;
            P.delay(this.kafkaFactory.startup_delay).then(() => this._consume());
        });
    }

    _safeParse(payload) {
        try {
            return JSON.parse(payload);
        } catch (e) {
            this.log(`error/${this.rule.name}`, e);
            this.hyper.post({
                uri: new URI('/sys/queue/events'),
                body: [ this._constructErrorMessage(e, payload) ]
            });
        }
    }

    _consume() {
        this._consuming = true;
        this.consumer.consumeAsync(1)
        .then((messages) => {
            this.hyper.metrics.increment(`${this.statName}_dequeue`, 1, 0.1);

            if (!messages.length) {
                // No new messages, delay a bit and try again.
                return P.delay(100);
            }

            const msg = messages[0];
            const message = this._safeParse(msg.value.toString('utf8'));

            const handler = this.getHandler(message);
            if (handler) {
                // We're pushing it to pending messages only if it matched so that items
                // that don't match don't count against the concurrency limit.
                this._pendingMsgs.push(msg);
                // Note: we don't return the promise here since we wanna process messages
                // asynchronously from consuming them to be able to fill up the pendingMsg
                // queue and achieve the level of concurrency we want.
                this.processMessage(message, handler)
                .finally(() => {
                    this._notifyFinished(msg);
                    if (this._pendingMsgs.length < this.concurrency && !this._consuming) {
                        this._consume();
                    }
                });
            }
        })
        .catch((e) => {
            // This errors must come from the KafkaConsumer
            // since the actual handler must never throw errors
            /* eslint-disable indent */
            switch (e.code) {
                case kafka.CODES.ERRORS.ERR__PARTITION_EOF:
                case kafka.CODES.ERRORS.ERR__TIMED_OUT:
                    // We're reading to fast, nothing is there, slow down a little bit
                    return P.delay(100);

                default:
                    this.log(`error/consumer/${this.rule.name}`, e);
            }
            /* eslint-enable indent */
        })
        .finally(() => {
            if (this._pendingMsgs.length < this.concurrency) {
                this._consume();
            } else {
                this._consuming = false;
            }
        });
    }

    /**
     * Checks whether a message should be rate-limited
     * @param {Object} expander the limiter key expander
     * @return {boolean}
     * @private
     */
    _rateLimitMessage(expander) {
        return P.all(this.rule.getRateLimiterTypes().map((type) => {
            const key = this.rule.getLimiterKey(type, expander);
            return this.hyper.get({
                uri: new URI(`/sys/limit/${type}/${key}`)
            });
        }))
        .thenReturn(false)
        .catch({ status: 404 }, () => {
            // If the limiter module is not configured, ignore
            return false;
        })
        // Will throw if any of the limiters failed,
        // the error message will say which one is failed.
        .catch({ status: 429 }, (e) => {
            this.log('error/ratelimit', {
                msg: 'Rate-limited message processing',
                rule_name: this.rule.name,
                limiter: e.body.message,
                limiter_key: e.body.key,
                event_str: utils.stringify(expander.message)
            });
            return true;
        });
    }

    _updateLimiters(expander, status, time) {
        return P.each(this.rule.getRateLimiterTypes(), (type) => {
            // TODO: calculate the cost function and actually POST the cost!

            if (status >= 500) {
                const limiterKey = this.rule.getLimiterKey(type, expander);
                return this.hyper.post({
                    uri: new URI(`/sys/limit/${type}/${limiterKey}`)
                }).catch({ status: 429 }, () => {
                    // No need to react here, we'll reject the next message
                }).catch({ status: 404 }, () => {
                    // If the limiter module is not configured, ignore
                });
            }
        });
    }

    _notifyFinished(finishedMsg) {
        this._pendingMsgs = this._pendingMsgs.filter(o => o.offset !== finishedMsg.offset);

        if (this.options.test_mode) {
            this.log('trace/commit', 'Running in TEST MODE; Offset commits disabled');
            return;
        }

        if (this._pendingMsgs.length) {
            this._toCommit = this._pendingMsgs.sort((msg1, msg2) => {
                return msg1.offset - msg2.offset;
            })[0];
        } else {
            this._toCommit = finishedMsg;
        }

        if (!this._commitTimeout) {
            this._commitTimeout = setTimeout(() => {
                this._commitTimeout = null;
                if (this._toCommit) {
                    const committing = this._toCommit;
                    return this.consumer.commitMessageAsync(committing)
                    .then(() => {
                        if (this._toCommit && this._toCommit.offset === committing.offset) {
                            // Don't commit what we've just committed
                            this._toCommit = undefined;
                        }
                    })
                    .catch((e) => {
                        this.log(`error/commit/${this.rule.name}`, {
                            msg: 'Commit failed',
                            offset: committing.offset,
                            raw_event: committing.value.toString(),
                            description: e.toString()
                        });
                    });
                }
            }, DEFAULT_COMMIT_INTERVAL);
        }
    }


    /** Private methods */

    _test(event) {
        try {
            const optionIndex = this.rule.test(event);
            if (optionIndex === -1) {
                // no match, drop the message
                this.log(`debug/${this.rule.name}`, () => ({
                    msg: 'Dropping event message',
                    event_str: utils.stringify(event)
                }));
            }
            return optionIndex;
        } catch (e) {
            this.log(`error/${this.rule.name}`, e);
            return -1;
        }
    }

    _sampleLog(event, request, res) {
        const sampleLog = () => {
            const log = {
                message: 'Processed event sample',
                event_str: utils.stringify(event),
                request,
                response: {
                    status: res.status,
                    headers: res.headers
                }
            };
            // Don't include the full body in the log
            if (res.status >= 400) {
                log.response.body = BaseExecutor.decodeError(res).body;
            }
            return log;
        };
        this.hyper.log('trace/sample', sampleLog);
    }

    _exec(origEvent, handler, statDelayStartTime, retryEvent) {
        const rule = this.rule;
        const startTime = Date.now();

        const expander = {
            message: origEvent,
            match: handler.expand(origEvent)
        };

        if (handler.sampler && !handler.sampler.accept(expander)) {
            this.log(`trace/${rule.name}`, () => ({
                msg: 'Disregarding event; Filtered by sampler',
                event: utils.stringify(origEvent)
            }));
            return P.resolve({ status: 200 });
        }

        this.log(`trace/${rule.name}`, () => ({
            msg: 'Event message received',
            event_str: utils.stringify(origEvent) }));

        // latency from the original event creation time to execution time
        this.hyper.metrics.endTiming([`${this.statName}_delay`],
            statDelayStartTime || new Date(origEvent.meta.dt));

        const redirectCheck = (res) => {
            if (res.status === 301) {
                // As we don't follow redirects, and we must use normalized titles,
                // receiving 301 indicates some error. Log a warning.
                this.log(`warn/${this.rule.name}`, () => ({
                    message: '301 redirect received, used a non-normalized title',
                    rule: this.rule.name,
                    event_str: utils.stringify(origEvent)
                }));
            }
        };

        return this._rateLimitMessage(expander)
        .then((isRateLimited) => {
            if (isRateLimited) {
                return { status: 200 };
            }
            return this._dedupeMessage(expander)
            .then((messageDeduped) => {
                if (messageDeduped) {
                    return { status: 200 };
                }
                return P.each(handler.exec, (tpl) => {
                    const request = tpl.expand(expander);
                    request.headers = Object.assign(request.headers, {
                        'x-request-id': origEvent.meta.request_id,
                        'x-triggered-by': utils.triggeredBy(retryEvent || origEvent)
                    });
                    return this.hyper.request(request)
                    .tap(redirectCheck)
                    .tap(this._sampleLog.bind(this, retryEvent || origEvent, request))
                    .tapCatch(this._sampleLog.bind(this, retryEvent || origEvent, request));
                })
                .tap(() => this._updateLimiters(expander, 200, new Date() - startTime))
                .tapCatch(e => this._updateLimiters(expander, e.status, new Date() - startTime))
                .finally(() => this.hyper.metrics.endTiming([`${this.statName}_exec`], startTime));
            });
        });
    }

    _retryTopicName() {
        return `change-prop.retry.${this.rule.topic}`;
    }

    _emitterId() {
        return `change-prop#${this.rule.name}`;
    }

    _constructRetryMessage(event, errorRes, retriesLeft, retryEvent) {
        return {
            meta: {
                topic: this._retryTopicName(),
                schema_uri: 'retry/1',
                uri: event.meta.uri,
                request_id: event.meta.request_id,
                id: undefined, // will be filled later
                dt: undefined, // will be filled later
                domain: event.meta.domain
            },
            triggered_by: utils.triggeredBy(retryEvent || event),
            emitter_id: this._emitterId(),
            retries_left: retriesLeft === undefined ? this.rule.spec.retry_limit : retriesLeft,
            original_event: event,
            reason: errorRes && errorRes.body && errorRes.body.title
        };
    }

    /**
     * Checks whether retry limit for this rule is exceeded.
     * @param {Object} message a retry message to check
     * @param {Error} [e] optional Error that caused a retry
     * @return {boolean}
     * @private
     */
    _isLimitExceeded(message, e) {
        if (message.retries_left <= 0) {
            this.log(`warn/${this.rule.name}`, () => ({
                message: 'Retry count exceeded',
                event_str: utils.stringify(message),
                status: e.status,
                page: message.meta.uri,
                description: `${e}`
            }));
            return true;
        }
        return false;
    }

    _catch(message, retryMessage, e) {
        const reportError = () => this.hyper.post({
            uri: new URI('/sys/queue/events'),
            body: [this._constructErrorMessage(e, message)]
        });

        if (e.constructor.name !== 'HTTPError') {
            // We've got an error, but it's not from the update request, it's
            // some bug in change-prop. Log and send a fatal error message.
            this.hyper.log(`error/${this.rule.name}`, () => ({
                message: 'Internal error in change-prop',
                description: `${e}`,
                stack: e.stack,
                event_str: utils.stringify(message)
            }));
            return reportError();
        }

        if (!this.rule.shouldIgnoreError(e)) {
            if (this.rule.shouldRetry(e)
                && !this._isLimitExceeded(retryMessage, e)) {
                return this.hyper.post({
                    uri: new URI('/sys/queue/events'),
                    body: [ retryMessage ]
                });
            }
            return reportError();
        }
    }


    /**
     * Create an error message for a special Kafka topic
     * @param {Error} e an exception that caused a failure
     * @param {string|Object} event an original event. In case JSON parsing failed - it's a string.
     */
    _constructErrorMessage(e, event) {
        const eventUri = typeof event === 'string' ? '/error/uri' : event.meta.uri;
        const domain = typeof event === 'string' ? 'unknown' : event.meta.domain;
        const now = new Date();
        const errorEvent = {
            meta: {
                topic: 'change-prop.error',
                schema_uri: 'error/1',
                uri: eventUri,
                request_id: typeof event === 'string' ? undefined : event.meta.request_id,
                id: uuid.fromDate(now),
                dt: now.toISOString(),
                domain
            },
            emitter_id: `change-prop#${this.rule.name}`,
            raw_event: typeof event === 'string' ? event : JSON.stringify(event),
            message: e.message,
            stack: e.stack
        };
        if (e.constructor === HTTPError) {
            errorEvent.details = {
                status: e.status,
                headers: e.headers,
                body: e.body
            };
        }
        return errorEvent;
    }

    close() {
        this.consumer.disconnect();
    }

    static decodeError(e) {
        if (Buffer.isBuffer(e.body)) {
            e.body = e.body.toString();
            try {
                e.body = JSON.parse(e.body);
            } catch (err) {
                // Not a JSON error
            }
        }
        return e;
    }
}

module.exports = BaseExecutor;
