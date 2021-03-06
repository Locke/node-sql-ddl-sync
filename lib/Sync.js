var Queue = require("./Queue").Queue;
var noOp  = function () {};
var _     = require("lodash");

exports.Sync = Sync;

function Sync(options) {
	var debug       = options.debug || noOp;
	var driver      = options.driver;
	var Dialect     = require("./Dialects/" + driver.dialect);
	var suppressColumnDrop = options.suppressColumnDrop;
	var collections = [];
	var types       = {};
	var total_changes;

	var processCollection = function (collection, cb) {
		Dialect.hasCollection(driver, collection.name, function (err, has) {
			if (err) {
				return cb(err);
			}

			if (!has) {
				return createCollection(collection, function (err) {
					if (err) return cb(err);
					return cb(null, true);
				});
			} else {
				return cb(null, false);
			}

			// I have concerns about the data integrity of the automatic sync process.
			// There has been lots of bugs and issues associated with it.
			/*Dialect.getCollectionProperties(driver, collection.name, function (err, columns) {
				if (err) {
					return cb(err);
				}

				return syncCollection(collection, columns, cb);
			});*/
		});
	};

	var createCollection = function (collection, cb) {
		var columns = [];
		var keys = [];
		var before  = [];
		var nextBefore = function () {
			if (before.length === 0) {
				return Dialect.createCollection(driver, collection.name, columns, keys, function () {
					return syncIndexes(collection.name, getCollectionIndexes(collection), cb);
				});
			}

			var next = before.shift();

			next(driver, function (err) {
				if (err) {
					return cb(err);
				}

				return nextBefore();
			});
		};

		for (var k in collection.properties) {
			var col = createColumn(collection.name, k, collection.properties[k]);

			if (col === false) {
				return cb(new Error("Unknown type for property '" + k + "'"));
			}

			if (collection.properties[k].key) {
				keys.push(k);
			}

			columns.push(col.value);

			if (col.before) {
				before.push(col.before);
			}
		}

		debug("Creating " + collection.name);

		if (typeof Dialect.processKeys == "function") {
			keys = Dialect.processKeys(keys);
		}

		total_changes += 1;

		return nextBefore();
	};

	var createColumn = function (collection, name, property) {
		var type = types.hasOwnProperty(property.type)
		         ? types[property.type].datastoreType(property)
		         : Dialect.getType(collection, name, property, driver);

		if (type === false) {
			return false;
		}
		if (typeof type == "string") {
			type = { value : type };
		}

		return {
			value  : driver.query.escapeId(name) + " " + type.value,
			before : type.before
		};
	};

	var syncCollection = function (collection, columns, cb) {
		var queue   = new Queue(cb);
		var last_k  = null;

		debug("Synchronizing " + collection.name);

		for (var k in collection.properties) {
			if (!columns.hasOwnProperty(k)) {
				var col = createColumn(collection.name, k, collection.properties[k]);

				if (col === false) {
					return cb(new Error("Unknown type for property '" + k + "'"));
				}

				debug("Adding column " + collection.name + "." + k + ": " + col.value);

				total_changes += 1;

				if (col.before) {
					queue.add(col, function (col, next) {
						col.before(driver, function (err) {
							if (err) {
								return next(err);
							}
							return Dialect.addCollectionColumn(driver, collection.name, col.value, last_k, next);
						});
					});
				} else {
					queue.add(function (next) {
						return Dialect.addCollectionColumn(driver, collection.name, col.value, last_k, next);
					});
				}
			} else if (needToSync(collection.properties[k], columns[k])) {
				var col = createColumn(collection.name, k, collection.properties[k]);

				if (col === false) {
					return cb(new Error("Unknown type for property '" + k + "'"));
				}

				debug("Modifying column " + collection.name + "." + k + ": " + col.value);

				total_changes += 1;

				if (col.before) {
					queue.add(col, function (col, next) {
						col.before(driver, function (err) {
							if (err) {
								return next(err);
							}
							return Dialect.modifyCollectionColumn(driver, collection.name, col.value, next);
						});
					});
				} else {
					queue.add(function (next) {
						return Dialect.modifyCollectionColumn(driver, collection.name, col.value, next);
					});
				}
			}

			last_k = k;
		}

        if ( !suppressColumnDrop ) {
            for (var k in columns) {
                if (!collection.properties.hasOwnProperty(k)) {
                    queue.add(function (next) {
                        debug("Dropping column " + collection.name + "." + k);

                        total_changes += 1;

                        return Dialect.dropCollectionColumn(driver, collection.name, k, next);
                    });
                }
            }
        }

		var indexes = getCollectionIndexes(collection);

		if (indexes.length) {
			queue.add(function (next) {
				return syncIndexes(collection.name, indexes, next);
			});
		}

		return queue.check();
	};

	var getCollectionIndexes = function (collection) {
		var indexes = [];
		var found;

		for (var k in collection.properties) {
			if (collection.properties[k].unique) {
				if (!Array.isArray(collection.properties[k].unique)) {
					collection.properties[k].unique = [ collection.properties[k].unique ];
				}

				for (var i = 0; i < collection.properties[k].unique.length; i++) {
					if (collection.properties[k].unique[i] === true) {
						indexes.push({
							name    : k + "_unique",
							unique  : true,
							columns : [ k ]
						});
					} else {
						found = false;

						for (var j = 0; j < indexes.length; j++) {
							if (indexes[j].name == collection.properties[k].unique[i]) {
								found = true;
								indexes[j].columns.push(k);
								break;
							}
						}
						if (!found) {
							indexes.push({
								name    : collection.properties[k].unique[i],
								unique  : true,
								columns : [ k ]
							});
						}
					}
				}
			}
			if (collection.properties[k].index) {
				if (!Array.isArray(collection.properties[k].index)) {
					collection.properties[k].index = [ collection.properties[k].index ];
				}

				for (var i = 0; i < collection.properties[k].index.length; i++) {
					if (collection.properties[k].index[i] === true) {
						indexes.push({
							name    : k + "_index",
							columns : [ k ]
						});
					} else {
						found = false;

						for (var j = 0; j < indexes.length; j++) {
							if (indexes[j].name == collection.properties[k].index[i]) {
								found = true;
								indexes[j].columns.push(k);
								break;
							}
						}
						if (!found) {
							indexes.push({
								name    : collection.properties[k].index[i],
								columns : [ k ]
							});
						}
					}
				}
			}
		}

		if (typeof Dialect.convertIndexes == "function") {
			indexes = Dialect.convertIndexes(collection, indexes);
		}

		return indexes;
	};

	var syncIndexes = function (name, indexes, cb) {
		if (indexes.length == 0) return cb(null);

		Dialect.getCollectionIndexes(driver, name, function (err, db_indexes) {
			if (err) return cb(err);

			var queue = new Queue(cb);

			for (var i = 0; i < indexes.length; i++) {
				if (!db_indexes.hasOwnProperty(indexes[i].name)) {
					debug("Adding index " + name + "." + indexes[i].name + " (" + indexes[i].columns.join(", ") + ")");

					total_changes += 1;

					queue.add(indexes[i], function (index, next) {
						return Dialect.addIndex(driver, index.name, index.unique, name, index.columns, next);
					});
					continue;
				} else if (!db_indexes[indexes[i].name].unique != !indexes[i].unique) {
					debug("Replacing index " + name + "." + indexes[i].name);

					total_changes += 1;

					queue.add(indexes[i], function (index, next) {
						return Dialect.removeIndex(driver, index.name, name, next);
					});
					queue.add(indexes[i], function (index, next) {
						return Dialect.addIndex(driver, index.name, index.unique, name, index.columns, next);
					});
				}
				delete db_indexes[indexes[i].name];
			}

			for (var i in db_indexes) {
				debug("Removing index " + name + "." + i);

				total_changes += 1;

				queue.add(i, function (index, next) {
					return Dialect.removeIndex(driver, index, name, next);
				});
			}

			return queue.check();
		});
	};

	var needToSync = function (property, column) {
		if (property.serial && property.type == "number") {
			property.type = "serial";
		}
		if (property.type != column.type) {
			if (typeof Dialect.supportsType != "function") {
				return true;
			}
			if (Dialect.supportsType(property.type) != column.type) {
				return true;
			}
		}
		if (property.type == "serial") {
			return false; // serial columns have a fixed form, nothing more to check
		}
		if (property.required != column.required && !property.key) {
			return true;
		}
		if (property.hasOwnProperty("defaultValue") && property.defaultValue != column.defaultValue) {
			return true;
		}
		if (property.type == "number" || property.type == "integer") {
			if (column.hasOwnProperty("size") && (property.size || 4) != column.size) {
				return true;
			}
		}
		if (property.type == "enum" && column.type == "enum") {
			if (_.difference(property.values, column.values).length > 0
			|| _.difference(column.values, property.values).length > 0) {
				return true;
			}
		}

		return false;
	};

	return {
		defineCollection : function (collection, properties) {
			collections.push({
				name       : collection,
				properties : properties
			});
			return this;
		},
		defineType : function (type, proto) {
			types[type] = proto;
			return this;
		},
		sync : function (cb) {
			var i = 0;
			var processNext = function () {
				if (i >= collections.length) {
					return cb(null, {
						changes : total_changes
					});
				}

				var collection = collections[i++];

				processCollection(collection, function (err) {
					if (err) {
						return cb(err);
					}

					return processNext();
				});
			};

			total_changes = 0;

			return processNext();
		}
	}
}
