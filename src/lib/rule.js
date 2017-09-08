'use strict';


const stringify = require('json-stable-stringify');
const HyperSwitch = require('hyperswitch');
const Sampler = require('./sampler');
const Template = HyperSwitch.Template;

const DEFAULT_RETRY_DELAY = 60000;  // One minute minimum retry delay
const DEFAULT_RETRY_FACTOR = 6;     // Exponential back-off
const DEFAULT_RETRY_LIMIT = 2;      // At most two retries
// Set a larger request timeout then RESTBase default 6 minutes;
const DEFAULT_REQUEST_TIMEOUT = 7 * 60 * 1000;


/**
 * Creates a JS function that verifies property equality
 * @param {Object} retryDefinition the condition in the format of 'retry_on' stanza
 * @return {Function} a function that verifies the condition
 */
function _compileErrorCheckCondition(retryDefinition) {
    function createCondition(retryCond, option) {
        if (retryCond === 'status') {
            const opt = option.toString();
            if (/^[0-9]+$/.test(opt)) {
                return `(res["${retryCond}"] === ${opt})`;
            }
            if (/^[0-9x]+$/.test(opt)) {
                return `/^${opt.replace(/x/g, "\\d")}$/.test(res["${retryCond}"])`;
            }
            throw new Error(`Invalid retry_on condition ${opt}`);
        } else {
            return `(stringify(res["${retryCond}"]) === '${stringify(option)}')`;
        }
    }

    const condition = [];
    Object.keys(retryDefinition).forEach((catchCond) => {
        if (Array.isArray(retryDefinition[catchCond])) {
            const orCondition = retryDefinition[catchCond].map(option =>
                createCondition(catchCond, option));
            condition.push(`(${orCondition.join(' || ')})`);
        } else {
            condition.push(createCondition(catchCond, retryDefinition[catchCond]));
        }
    });
    const code = `return (${condition.join(' && ')});`;
    /* jslint evil: true */
    /* eslint-disable no-new-func */
    return new Function('stringify', 'res', code).bind(null, stringify);
    /* eslint-enable no-new-func */
}

function _getMatchObjCode(obj) {
    if (obj.constructor === Object) {
        return `{${Object.keys(obj).map((key) => {
            return `${key}: ${_getMatchObjCode(obj[key])}`;
        }).join(', ')}}`;
    }
    return obj;
}

function _compileNamedRegex(obj, result, name, fieldName) {
    const captureNames = [];
    const normalRegex = obj.replace(/\(\?<(\w+)>/g, (_, name) => {
        captureNames.push(name);
        return '(';
    });
    const numGroups = (new RegExp(`${normalRegex.toString()}|`)).exec('').length - 1;

    if (captureNames.length && captureNames.length !== numGroups) {
        throw new Error(`${'Invalid match regex. ' +
        'Mixing named and unnamed capture groups are not supported. Regex: '}${obj}`);
    }

    if (!captureNames.length) {
        // No named captures
        result[fieldName] = `${normalRegex}.exec(${name})`;
    } else {
        let code = `(() => { const execRes = ${normalRegex}.exec(${name}); const res = {}; `;
        captureNames.forEach((captureName, index) => {
            code += `res['${captureName}'] = execRes[${index + 1}]; `;
        });
        result[fieldName] = `${code}return res; })()`;
    }

    return `typeof ${name} === "string" && ${normalRegex}.test(${name})`;
}

function _compileMatch(obj, result, name, fieldName) {
    function _compileArrayMatch(obj, name) {
        const itemsCheck = obj.map((item, index) =>
            `${name}.find((item) => ${_compileMatch(item, {}, 'item', index)})`).join(' && ');
        return `Array.isArray(${name})${itemsCheck.length ? (` && ${itemsCheck}`) : ''}`;
    }

    if (obj.constructor !== Object) {
        if (Array.isArray(obj)) {
            return _compileArrayMatch(obj, name);
        }
        if (obj === 'undefined') {
            return `${name} === undefined`;
        }
        if (typeof obj !== 'string') {
            // not a string, so it has to match exactly
            result[fieldName] = obj;
            return `${name} === ${obj}`;
        }
        if (!/^\/.+\/[gimuy]{0,5}$/.test(obj)) {
            // not a regex, quote the string
            result[fieldName] = `'${obj}'`;
            return `${name} === '${obj}'`;
        }
        // it's a regex, we have to the test the arg
        return _compileNamedRegex(obj, result, name, fieldName);
    }

    // this is an object, we need to split it into components
    const subObj = fieldName ? {} : result;
    const test = Object.keys(obj).map(
        (key) => {
            const propertyName = `${name}['${key}']`;
            if (obj[key].constructor === Object) {
                return `${propertyName} && ${_compileMatch(obj[key], subObj, propertyName, key)}`;
            }
            return _compileMatch(obj[key], subObj, propertyName, key);
        })
    .join(' && ');
    if (fieldName) {
        result[fieldName] = subObj;
    }
    return test;
}

class Rule {
    constructor(name, spec) {
        this.name = name;
        this.spec = spec || {};

        const  topic = this.spec.topic;
        if (!topic || typeof topic !== 'string' || !topic.length) {
            throw new Error(`No topic specified for rule ${this.name}`);
        }

        if (/^\/.+\/$/.test(topic)) {
            // Ok, we've got a regex topic! Compile the regex.
            this.topic = new RegExp(topic.substring(1, topic.length - 1));
        } else {
            this.topic = topic;
        }

        this.spec.retry_on = this.spec.retry_on || {
            status: [ '50x' ]
        };
        this.spec.ignore = this.spec.ignore || {
            status: [ 412 ]
        };
        this.spec.retry_delay = this.spec.retry_delay || DEFAULT_RETRY_DELAY;
        this.spec.retry_limit = this.spec.retry_limit || DEFAULT_RETRY_LIMIT;
        this.spec.retry_factor = this.spec.retry_factor || DEFAULT_RETRY_FACTOR;
        this.spec.timeout = this.spec.timeout || DEFAULT_REQUEST_TIMEOUT;

        this.shouldRetry = _compileErrorCheckCondition(this.spec.retry_on);
        this.shouldIgnoreError = _compileErrorCheckCondition(this.spec.ignore);

        this._limiterKeyTemplates = {};
        if (this.spec.limiters) {
            Object.keys(this.spec.limiters).forEach((type) => {
                try {
                    this._limiterKeyTemplates[type] = new Template(this.spec.limiters[type]);
                } catch (e) {
                    throw new Error(`Compilation failed for limiter ${type}. Error: ${e.message}`);
                }
            });
        }

        this._options = (this.spec.cases || [ this.spec ]).map((option) => {
            const matcher = this._processMatch(option.match) || {};
            const result = {
                exec: this._processExec(option.exec),
                match: matcher.test || (() => true),
                expand: matcher.expand,
                match_not: this._processMatchNot(option.match_not)
            };
            // TODO: Support more global sampler. For example, if case of
            // `cases` stanza is used, we need to be able to fallback to
            // the more global sample stanza from the higher-leve spec.
            // TODO: possibly support specifying the `sample` options on the
            // sys/kafka module level and assign it to all the rules when
            // they're created in the _subscribeRules method.
            if (option.sample) {
                result.sampler = new Sampler(option.sample);
            }
            return result;
        });
    }

    isRegexRule() {
        return this.topic instanceof RegExp;
    }

    _processMatchNot(matchNot) {
        if (!matchNot) {
            return (() => false);
        }
        if (Array.isArray(matchNot)) {
            const tests = matchNot.map((match) => {
                return (this._processMatch(match)).test;
            }).filter(func => !!func);
            return message => tests.some(test => test(message));
        }
        return (this._processMatch(matchNot)).test || (() => false);
    }

    /**
     * Tests the message against the compiled evaluation test. In case the rule contains
     * multiple options, the first one that's matched is choosen.
     * @param {Object} message the message to test
     * @return {Integer} index of the matched option or -1 of nothing matched
     */
    test(message) {
        return this._options.findIndex(option =>
            option.match(message) && !option.match_not(message));
    }

    /**
     * Returns a rule handler that contains of a set of exec template
     * and expander function
     * @param {Integer} index an index of the switch option
     * @return {Object}
     */
    getHandler(index) {
        const option = this._options[index];
        return {
            exec: option.exec,
            sampler: option.sampler,
            expand: (message) => {
                return option.expand && option.expand(message) || {};
            }
        };
    }

    /**
     * Returns the key to use for a rate-limiter of the certain type
     * @param {string} type limiter type
     * @param {Object} expander the expander containing the message and match
     * @return {string|null}
     */
    getLimiterKey(type, expander) {
        const keyTemplate = this._limiterKeyTemplates[type];
        if (!keyTemplate) {
            return null;
        }
        return keyTemplate.expand(expander);
    }

    getRateLimiterTypes() {
        return Object.keys(this._limiterKeyTemplates);
    }

    _processMatch(match) {
        if (!match) {
            // No particular match specified, so we
            // should accept all events for this topic
            return;
        }

        const obj = {};
        const test = _compileMatch(match, obj, 'message');
        try {
            return {
                /* eslint-disable no-new-func */
                /* jslint evil: true  */
                test: new Function('message', `return ${test}`),
                /* jslint evil: true  */
                expand: new Function('message', `return ${_getMatchObjCode(obj)}`)
                /* eslint-enable no-new-func */
            };
        } catch (e) {
            throw new Error('Invalid match object given!');
        }
    }

    _processExec(exec) {
        if (!exec) {
            // nothing to do, the rule is a no-op
            this.noop = true;
            return;
        }

        if (!Array.isArray(exec)) {
            exec = [exec];
        }

        const templates = [];
        for (let idx = 0; idx < exec.length; idx++) {
            const req = exec[idx];
            if (req.constructor !== Object || !req.uri) {
                throw new Error(`In rule ${this.name}, request number ${idx}
                    must be an object and must have the "uri" property`);
            }
            req.method = req.method || 'get';
            req.headers = req.headers || {};
            req.followRedirect = false;
            req.retries = 0;
            req.timeout = this.spec.timeout;

            if (!this.spec.decode_results) {
                req.encoding = null;
            }
            templates.push(new Template(req));
        }
        return templates;
    }

    clone(newTopic) {
        const newSpec = Object.assign({}, this.spec);
        const newName = `${this.name}-${newTopic.replace(/\./g, '_')}`;
        newSpec.topic = newTopic;
        return new Rule(newName, newSpec);
    }
}

module.exports = Rule;
