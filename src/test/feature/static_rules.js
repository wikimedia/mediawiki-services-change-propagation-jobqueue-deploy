"use strict";

const ChangeProp = require('../utils/changeProp');
const nock = require('nock');
const preq = require('preq');
const Ajv = require('ajv');
const assert = require('assert');
const yaml = require('js-yaml');
const common = require('../utils/common');
const P = require('bluebird');

process.env.UV_THREADPOOL_SIZE = 128;

describe('Basic rule management', function() {
    this.timeout(10000);

    const changeProp = new ChangeProp('config.test.yaml');

    let producer;
    let retrySchema;
    let errorSchema;

    before(function() {
        // Setting up might take some tome, so disable the timeout
        this.timeout(30000);

        return changeProp.start()
        .then(() => preq.get({ uri: 'https://raw.githubusercontent.com/wikimedia/mediawiki-event-schemas/master/jsonschema/change-prop/retry/1.yaml' }))
        .then((res) => retrySchema = yaml.safeLoad(res.body))
        .then(() => preq.get({ uri: 'https://raw.githubusercontent.com/wikimedia/mediawiki-event-schemas/master/jsonschema/error/1.yaml' }))
        .then((res) => errorSchema = yaml.safeLoad(res.body))
        .then(() => common.factory.createProducer(console.log.bind(console)))
        .then((result) => producer = result);
    });

    it('Should call simple executor', () => {
        const random = common.randomString();
        const service = nock('http://mock.com', {
            reqheaders: {
                test_header_name: 'test_header_value',
                'content-type': 'application/json',
                'x-request-id': common.SAMPLE_REQUEST_ID,
                'x-triggered-by': 'simple_test_rule:/sample/uri',
                'user-agent': 'ChangePropTestSuite'
            }
        })
        .post('/', {
            'test_field_name': 'test_field_value',
            'derived_field': 'test',
            'random_field': random
        }).reply({});

        return P.each([
            JSON.stringify(common.eventWithMessageAndRandom('this_will_not_match', random)),
            JSON.stringify(common.eventWithMessageAndRandom('test', random)),
            // The empty message should cause a failure in the match test
            '{}'
        ].map((strMsg) => Buffer.from(strMsg)),
            (msg) => producer.produce('test_dc.simple_test_rule', 0, msg))
        .then(() => common.checkAPIDone(service))
        .finally(() => nock.cleanAll());
    });

    it('Should retry simple executor', () => {
        const random = common.randomString();
        const service = nock('http://mock.com', {
            reqheaders: {
                test_header_name: 'test_header_value',
                'content-type': 'application/json',
                'x-request-id': common.SAMPLE_REQUEST_ID,
                'user-agent': 'ChangePropTestSuite'
            }
        })
        .post('/', {
            'test_field_name': 'test_field_value',
            'derived_field': 'test',
            'random_field': random
        })
        .matchHeader('x-triggered-by', 'simple_test_rule:/sample/uri')
        .reply(500, {})
        .post('/', {
            'test_field_name': 'test_field_value',
            'derived_field': 'test',
            'random_field': random
        })
        .matchHeader('x-triggered-by', 'simple_test_rule:/sample/uri,change-prop.retry.simple_test_rule:/sample/uri')
        .reply(200, {});

        return P.try(() => producer.produce('test_dc.simple_test_rule', 0,
            Buffer.from(JSON.stringify(common.eventWithMessageAndRandom('test', random)))))
        .then(() => common.checkAPIDone(service))
        .finally(() => nock.cleanAll());
    });

    it('Should retry simple executor no more than limit', () => {
        const random = common.randomString();
        const service = nock('http://mock.com', {
            reqheaders: {
                test_header_name: 'test_header_value',
                'content-type': 'application/json',
                'x-request-id': common.SAMPLE_REQUEST_ID,
                'user-agent': 'ChangePropTestSuite'
            }
        })
        .post('/', {
            'test_field_name': 'test_field_value',
            'derived_field': 'test',
            'random_field': random
        })
        .matchHeader('x-triggered-by', 'simple_test_rule:/sample/uri')
        .reply(500, {})
        .post('/', {
            'test_field_name': 'test_field_value',
            'derived_field': 'test',
            'random_field': random
        })
        .matchHeader('x-triggered-by', 'simple_test_rule:/sample/uri,change-prop.retry.simple_test_rule:/sample/uri')
        .reply(500, {})
        .post('/', {
            'test_field_name': 'test_field_value',
            'derived_field': 'test',
            'random_field': random
        })
        .matchHeader('x-triggered-by', 'simple_test_rule:/sample/uri,change-prop.retry.simple_test_rule:/sample/uri,change-prop.retry.simple_test_rule:/sample/uri')
        .reply(500, {})
        // Next one must never get called, we verify that by checking pending mocks
        .post('/', {
            'test_field_name': 'test_field_value',
            'derived_field': 'test',
            'random_field': random
        })
        .reply(500, {});

        return P.try(() => producer.produce('test_dc.simple_test_rule', 0,
            Buffer.from(JSON.stringify(common.eventWithMessageAndRandom('test', random)))))
        .then(() => common.checkPendingMocks(service, 1))
        .finally(() => nock.cleanAll());
    });

    it('Should emit valid retry message', function() {
        this.timeout(10000);
        const random = common.randomString();
        nock('http://mock.com', {
            reqheaders: {
                test_header_name: 'test_header_value',
                'content-type': 'application/json',
                'x-request-id': common.SAMPLE_REQUEST_ID,
                'user-agent': 'ChangePropTestSuite'
            }
        })
        .post('/', {
            'test_field_name': 'test_field_value',
            'derived_field': 'test',
            'random_field': random
        })
        .reply(500, {})
        .post('/', {
            'test_field_name': 'test_field_value',
            'derived_field': 'test',
            'random_field': random
        })
        .reply(200, {});

        return common.factory.createConsumer(
            'change-prop-test-consumer-valid-retry',
            'test_dc.change-prop.retry.simple_test_rule' )
        .then((retryConsumer) => {
            setTimeout(() => producer.produce('test_dc.simple_test_rule', 0,
                Buffer.from(JSON.stringify(common.eventWithMessageAndRandom('test', random)))), 2000);

            function check() {
                return retryConsumer.consumeAsync(1)
                .catch(check)
                .then((messages) => {
                    if (!messages.length) {
                        return;
                    }

                    const message = messages[0];
                    const ajv = new Ajv();
                    const validate = ajv.compile(retrySchema);
                    const msg = JSON.parse(message.value.toString());
                    const valid = validate(msg);
                    if (!valid) {
                        throw new assert.AssertionError({
                            message: ajv.errorsText(validate.errors)
                        });
                    }
                    if (msg.original_event.random !== random) {
                        return check();
                    }

                    if (msg.triggered_by !== 'simple_test_rule:/sample/uri') {
                        throw new Error('TriggeredBy should be equal to simple_test_rule:/sample/uri');
                    }
                });
            }
            return check();
        });
    });

    it('Should not retry if retry_on not matched', () => {
        const random = common.randomString();
        const service = nock('http://mock.com', {
            reqheaders: {
                test_header_name: 'test_header_value',
                'content-type': 'application/json',
                'x-request-id': common.SAMPLE_REQUEST_ID,
                'x-triggered-by': 'simple_test_rule:/sample/uri',
                'user-agent': 'ChangePropTestSuite'
            }
        })
        .post('/', {
            'test_field_name': 'test_field_value',
            'derived_field': 'test',
            'random_field': random
        })
        .reply(404, {})
        // Next one must never get called, we verify that by checking pending mocks
        .post('/', {
            'test_field_name': 'test_field_value',
            'derived_field': 'test',
            'random_field': random
        })
        .reply(404, {});

        return P.try(() => producer.produce('test_dc.simple_test_rule', 0,
            Buffer.from(JSON.stringify(common.eventWithMessageAndRandom('test', random)))))
        .then(() => common.checkPendingMocks(service, 1))
        .finally(() => nock.cleanAll());
    });

    it('Should not follow redirects', () => {
        const service = nock('http://mock.com/')
        .get('/will_redirect')
        .reply(301, '', {
            'location': 'http://mock.com/redirected_resource'
        })
        // Next one must never get called, we verify that by checking pending mocks
        .get('/redirected_resource')
        .reply(200, {});

        return P.try(() => producer.produce('test_dc.simple_test_rule', 0,
            Buffer.from(JSON.stringify(common.eventWithMessage('redirect')))))
        .then(() => common.checkPendingMocks(service, 1))
        .finally(() => nock.cleanAll());
    });

    it('Should not crash with unparsable JSON', () => {
        const service = nock('http://mock.com', {
            reqheaders: {
                test_header_name: 'test_header_value',
                'content-type': 'application/json',
                'x-request-id': common.SAMPLE_REQUEST_ID,
                'x-triggered-by': 'simple_test_rule:/sample/uri',
                'user-agent': 'ChangePropTestSuite'
            }
        })
        .post('/', {
            'test_field_name': 'test_field_value',
            'derived_field': 'test'
        })
        .reply(200, {});

        return P.each([
            'non-parsable-json',
            JSON.stringify(common.eventWithMessage('test'))
        ].map((strMsg) => Buffer.from(strMsg)),
            (msg) => producer.produce('test_dc.simple_test_rule', 0, msg))
        .then(() => common.checkAPIDone(service))
        .finally(() => nock.cleanAll());
    });

    it('Should support producing to topics on exec', () => {
        const service = nock('http://mock.com', {
            reqheaders: {
                test_header_name: 'test_header_value',
                'content-type': 'application/json',
                'x-request-id': common.SAMPLE_REQUEST_ID,
                'user-agent': 'ChangePropTestSuite'
            }
        })
        .post('/', {
            'test_field_name': 'test_field_value',
            'derived_field': 'test'
        })
        .matchHeader('x-triggered-by', 'test_dc.kafka_producing_rule:/sample/uri,simple_test_rule:/sample/uri')
        .times(2).reply({});

        return P.try(() => producer.produce('test_dc.kafka_producing_rule', 0,
            Buffer.from(JSON.stringify(common.eventWithProperties('test_dc.kafka_producing_rule', {
                produce_to_topic: 'simple_test_rule'
            })))))
        .then(() => common.checkAPIDone(service))
        .finally(() => nock.cleanAll());
    });

    it('Should emit valid messages to error topic', () => {
        return common.factory.createConsumer(
            'change-prop-test-error-consumer',
            'test_dc.change-prop.error')
        .then((errorConsumer) => {
            setTimeout(() =>
                producer.produce('test_dc.simple_test_rule', 0, Buffer.from('not_a_json_message')), 2000);

            function check() {
                return errorConsumer.consumeAsync(1)
                .catch(check)
                .then((messages) => {
                    if (!messages.length) {
                        return;
                    }

                    const message = messages[0];
                    const ajv = new Ajv();
                    const validate = ajv.compile(errorSchema);
                    const valid = validate(JSON.parse(message.value.toString()));
                    if (!valid) {
                        throw  new assert.AssertionError({
                            message: ajv.errorsText(validate.errors)
                        });
                    }
                });
            }

            return check();
        });
    });

    it('Sampling should only propagate a stable subset', () => {
        const service = nock('http://mock.com/')
        .get('/en.wikipedia.org/N0ryO6Lrp')
        .reply(200, {})
        .get('/en.wikipedia.org/rpiwQuPlA')
        .reply(200, {});

        return P.try(() => producer.produce('test_dc.sample_test_rule', 0,
            Buffer.from(JSON.stringify(
                // en.wikipedia.org-N0ryO6Lrp hashes to lower 20% of hashspace (should pass)
                common.eventWithProperties('test_dc.sample_test_rule', { page_title: 'N0ryO6Lrp', message: 'sampled' })
            )))
        )
        .then(() => producer.produce('test_dc.sample_test_rule', 0,
            Buffer.from(JSON.stringify(
                // en.wikipedia.org-rpiwQuPlA hashes to upper 80% of hashspace (should fail)
                common.eventWithProperties('test_dc.sample_test_rule', { page_title: 'rpiwQuPlA', message: 'sampled' })
            )))
        )
        .then(() => common.checkPendingMocks(service, 1))
        .finally(() => nock.cleanAll());
    });

    after(() => changeProp.stop());
});
