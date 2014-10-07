var classExtend = require('ampersand-class-extend');
var Events = require('backbone-events-standalone');
var ampHistory = require('./ampersand-history-query-parameters');
var _ = require('underscore');


// Routers map faux-URLs to actions, and fire events when routes are
// matched. Creating a new one sets its `routes` hash, if not set statically.
var Router = module.exports = function (options) {
    options || (options = {});
    this.history = options.history || ampHistory;
    if (options.routes) this.routes = options.routes;
    this._bindRoutes();
    this.initialize.apply(this, arguments);
};

// Cached regular expressions for matching named param parts and splatted
// parts of route strings.
var queryStringParam = /^\?(.*)/;
var optionalParam = /\((.*?)\)/g;
var namedParam    = /(\(\?)?:\w+/g;
var splatParam    = /\*\w+/g;
var escapeRegExp  = /[\-{}\[\]+?.,\\\^$|#\s]/g;
var namesPattern = /[\:\*]([^\:\?\/]+)/g;

Router.arrayValueSplit = '|';

// Set up all inheritable **Backbone.Router** properties and methods.
_.extend(Router.prototype, Events, {

    initialize: function (options) {
        this.encodedSplatParts = options && options.encodedSplatParts;
    },

    route: function (route, name, callback) {
        if (!_.isRegExp(route)) route = this._routeToRegExp(route);
        if (_.isFunction(name)) {
            callback = name;
            name = '';
        }
        if (!callback) callback = this[name];
        var router = this;
        this.history.route(route, function (fragment) {
            var args = router._extractParameters(route, fragment);
            if (router.execute(callback, args, name) !== false) {
                router.trigger.apply(router, ['route:' + name].concat(args));
                router.trigger('route', name, args);
                router.history.trigger('route', router, name, args);
            }
        });
        return this;
    },

    // Execute a route handler with the provided parameters.  This is an
    // excellent place to do pre-route setup or post-route cleanup.
    execute: function (callback, args, name) {
        if (callback) callback.apply(this, args);
    },

    // Simple proxy to `ampHistory` to save a fragment into the history.
    navigate: function (fragment, options) {
        this.history.navigate(fragment, options);
        return this;
    },

    // Helper for doing `internal` redirects without adding to history
    // and thereby breaking backbutton functionality.
    redirectTo: function (newUrl) {
        this.navigate(newUrl, {replace: true, trigger: true});
    },

    // Bind all defined routes to `history`. We have to reverse the
    // order of the routes here to support behavior where the most general
    // routes can be defined at the bottom of the route map.
    _bindRoutes: function () {
        if (!this.routes) return;
        this.routes = _.result(this, 'routes');
        var route, routes = Object.keys(this.routes);
        while ((route = routes.pop()) != null) {
            this.route(route, this.routes[route]);
        }
    },

    _routeToRegExp: function (route) {
        var splatMatch = (splatParam.exec(route) || {index: -1}),
            namedMatch = (namedParam.exec(route) || {index: -1}),
            paramNames = route.match(namesPattern) || [];

        route = route.replace(escapeRegExp, '\\$&')
                        .replace(optionalParam, '(?:$1)?')
                        .replace(namedParam, function (match, optional) {
                            return optional ? match : '([^\\/\\?]+)';
                        })
                        // `[^??]` is hacking around a regular expression bug under iOS4.
                        // If only `[^?]` is used then paths like signin/photos will fail
                        // while paths with `?` anywhere, like `signin/photos?`, will succeed.
                        .replace(splatParam, '([^??]*?)');
        route += '(\\?.*)?';
        var rtn = new RegExp('^' + route + '$');

        // use the rtn value to hold some parameter data
        if (splatMatch.index >= 0) {
                // there is a splat
            if (namedMatch >= 0) {
                // negative value will indicate there is a splat match before any named matches
                rtn.splatMatch = splatMatch.index - namedMatch.index;
            } else {
                rtn.splatMatch = -1;
            }
        }
        // Map and remove any trailing ')' character that has been caught up in regex matching
        rtn.paramNames = _.map(paramNames, function (name) { return name.replace(/\)$/, '').substring(1); });
        rtn.namedParameters = this.namedParameters;

        return rtn;
    },

    /**
    * Given a route, and a URL fragment that it matches, return the array of
    * extracted parameters.
    */
    _extractParameters: function (route, fragment) {
        var params = route.exec(fragment).slice(1),
            namedParams = {};
        if (params.length > 0 && !params[params.length - 1]) {
            // remove potential invalid data from query params match
            params.splice(params.length - 1, 1);
        }

        // do we have an additional query string?
        var match = params.length && params[params.length - 1] && params[params.length - 1].match(queryStringParam);
        if (match) {
            var queryString = match[1];
            var data = {};
            if (queryString) {
                var self = this;
                iterateQueryString(queryString, function (name, value) {
                    self._setParamValue(name, value, data);
                });
            }
            params[params.length - 1] = data;
            _.extend(namedParams, data);
        }

        // decode params
        var length = params.length;
        if (route.splatMatch && this.encodedSplatParts) {
            if (route.splatMatch < 0) {
                // splat param is first
                return params;
            } else {
                length = length - 1;
            }
        }

        for (var i=0; i<length; i++) {
          if (_.isString(params[i])) {
            params[i] = parseParams(params[i]);
            if (route.paramNames && route.paramNames.length >= i-1) {
              namedParams[route.paramNames[i]] = params[i];
            }
          }
        }

        return (Router.namedParameters || route.namedParameters) ? [namedParams] : params;
    },

    /**
    * Set the parameter value on the data hash
    */
    _setParamValue: function (key, value, data) {
        // use '.' to define hash separators
        key = key.replace('[]', '');
        key = key.replace('%5B%5D', '');
        var parts = key.split('.');
        var _data = data;
        for (var i = 0; i < parts.length; i++) {
            var part = parts[i];
            if (i === parts.length - 1) {
                // set the value
                _data[part] = this._decodeParamValue(value, _data[part]);
            } else {
                _data = _data[part] = _data[part] || {};
            }
        }
    },

    /**
    * Decode an individual parameter value (or list of values)
    * @param value the complete value
    * @param currentValue the currently known value (or list of values)
    */
    _decodeParamValue: function (value, currentValue) {
        // '|' will indicate an array.  Array with 1 value is a=|b - multiple values can be a=b|c
        var splitChar = Router.arrayValueSplit;
        if (splitChar && value.indexOf(splitChar) >= 0) {
            var values = value.split(splitChar);
            // clean it up
            for (var i = values.length - 1; i >= 0; i--) {
                if (!values[i]) {
                    values.splice(i, 1);
                } else {
                    values[i] = parseParams(values[i]);
                }
            }
            return values;
        }

        value = parseParams(value);

        if (!currentValue) {
            return value;
        } else if (_.isArray(currentValue)) {
            currentValue.push(value);
            return currentValue;
        } else {
            return [currentValue, value];
        }
    },

    /**
    * Return the route fragment with queryParameters serialized to query parameter string
    */
    toFragment: function (route, queryParameters) {
        if (queryParameters) {
            if (!_.isString(queryParameters)) {
                queryParameters = toQueryString(queryParameters);
            }
            if (queryParameters) {
                route += '?' + queryParameters;
            }
        }
        return route;
    }

});


/**
 * Serialize the val hash to query parameters and return it.  Use the namePrefix to prefix all param names (for recursion)
 */
function toQueryString(val, namePrefix) {
    var splitChar = Router.arrayValueSplit;
    function encodeSplit(val) { return String(val).replace(splitChar, encodeURIComponent(splitChar)); }

    if (!val) {
        return '';
    }

    namePrefix = namePrefix || '';
    var rtn = [];
    _.each(val, function (_val, name) {
        name = namePrefix + name;

        if (_.isString(_val) || _.isNumber(_val) || _.isBoolean(_val) || _.isDate(_val)) {
          // primitive type
          if (_val != null) {
            rtn.push(name + '=' + encodeSplit(encodeURIComponent(_val)));
          }
        } else if (_.isArray(_val)) {
            // arrays use Backbone.Router.arrayValueSplit separator
            var str = '';
            for (var i = 0; i < _val.length; i++) {
                var param = _val[i];
                if (param != null) {
                    str += splitChar + encodeSplit(param);
                }
            }
            if (str) {
                rtn.push(name + '=' + str);
            }
        } else {
            // dig into hash
            var result = toQueryString(_val, name + '.');
            if (result) {
                rtn.push(result);
            }
        }
    });

    return rtn.join('&');
}

function parseParams(value) {
    // decodeURIComponent doesn't touch '+'
    try {
        return decodeURIComponent(value.replace(/\+/g, ' '));
    } catch (err) {
        // Failover to whatever was passed if we get junk data
        return value;
    }
}

function iterateQueryString(queryString, callback) {
    var keyValues = queryString.split('&');
    _.each(keyValues, function (keyValue) {
        var arr = keyValue.split('=');
        callback(arr.shift(), arr.join('='));
    });
}

Router.extend = classExtend;
