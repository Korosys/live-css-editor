#!/usr/bin/env node

/* eslint-env node */

var updateNotifier = require('update-notifier'),
    pkg = require('./package.json'),
    notifier = updateNotifier({
        // updateCheckInterval: 0,     // Useful when testing
        pkg: pkg
    });

if (notifier.update) {
    // Notify about update immediately when the script executes
    notifier.notify({
        defer: false,
        shouldNotifyInNpmScript: true
    });

    // Notify about update when the script ends after running for at least 15 seconds
    setTimeout(function () {
        notifier.notify({
            shouldNotifyInNpmScript: true
        });
    }, 15000);
}

var nPath = require('path'),
    fs = require('fs');

var chokidar = require('chokidar'),
    anymatch = require('anymatch'),
    boxen = require('boxen'),
    _uniq = require('lodash/uniq.js'),
    findFreePort = require('find-free-port');

var logger = require('note-down');
logger.removeOption('showLogLine');

var Emitter = require('tiny-emitter'),
    emitter = new Emitter();

var express = require('express'),
    app = express(),
    http = require('http').Server(app),
    io = require('socket.io')(http);

var defaultPort = 3456;

var logAndThrowError = function (msg) {
    logger.errorHeading(msg);
    throw new Error(msg);
};

// If being executed as a binary and not via require()
if (!module.parent) {
    var argv = require('yargs')
        .help(false)
        .argv;
    var inDebugMode = argv.d || argv.debug;

    var localIpAddressesAndHostnames = [];
    try {
        localIpAddressesAndHostnames = require('local-ip-addresses-and-hostnames').getLocalIpAddressesAndHostnames();
    } catch (e) {
        // do nothing
    }

    var verboseLogging = false;
    if (argv.v || argv.verbose) {
        verboseLogging = true;
    }

    var showHelp = function () {
        logger.verbose([
            '',
            'Format:   live-css [--root=<project-root-folder>] [--help]',
            'Examples: live-css',
            '          live-css --help',
            '          live-css --root=project/css',
            'Options:  -h --help                        Show help',
            '          -r --root=<project-root-folder>  Folder containing files to monitor',
            '             --list-files                  List the files being monitored',
            '          -p --port=<port-number>          Port number to run live-css server',
            '             --allow-symlinks              Allow symbolic links',
            '             --init                        Generate the configuration file',
            '             --debug                       Extra logging to help in debugging live-css',
            '          -v --version                     Output the version number',
            ''
        ].join('\n'));
    };

    if (argv.h || argv.help) {
        showHelp();
        process.exit(0);
    } else if (argv.init) {
        var exampleConfigFilePath = nPath.resolve(__dirname, 'example.live-css.config.js'),
            exampleText;
        try {
            exampleText = fs.readFileSync(exampleConfigFilePath, 'utf8');
        } catch (e) {
            logger.fatal('Error:\nUnable to read example configuration file from ' + exampleConfigFilePath);
            process.exit(1);
        }

        var targetConfigFilePath = nPath.resolve(process.cwd(), '.live-css.config.js');
        try {
            fs.writeFileSync(targetConfigFilePath, exampleText);
            logger.success('\nConfiguration file has been written at:\n    ' + targetConfigFilePath);
            logger.info('\nNow, when you execute the ' + logger.chalk.underline('live-css') + ' command from this directory, it would load the required options from this configuration file.\n');
        } catch (e) {
            logger.error(' ✗ Error: Unable to write configuration file to: ' + targetConfigFilePath);
            process.exit(1);
        }
    } else {
        logger.verbose([
            '',
            'Run ' + logger.chalk.underline('live-css --help') + ' to see the available options.'
        ].join('\n'));

        var configFilePath = nPath.resolve(process.cwd(), '.live-css.config.js'),
            configFileExists = fs.existsSync(configFilePath),
            flagConfigurationLoaded = false,
            configuration = {};

        if (configFileExists) {
            try {
                configuration = require(configFilePath);
                flagConfigurationLoaded = true;
                logger.verbose('Loaded configuration from ' + configFilePath);
                if (inDebugMode) {
                    logger.log('\n\nConfiguration:');
                    logger.log(configuration);
                }
            } catch (e) {
                logger.warnHeading('\nUnable to read configuration from ' + configFilePath);
                logger.warn('The configuration file contents needs to follow JavaScript syntax.\neg: https://github.com/webextensions/live-css-editor/tree/master/live-css/example.live-css.config.js');
            }
        } else {
            logger.verbose([
                'Run ' + logger.chalk.underline('live-css --init') + ' to generate the configuration file (recommended).'
            ].join('\n'));
        }

        var connectedSessions = 0;

        app.get('/', function(req, res) {
            res.sendFile(__dirname + '/index.html');
        });

        var listFiles = argv.listFiles || false;

        var allowSymlinks = argv.allowSymlinks || false;
        var configRoot = argv.root || configuration.root;
        var watcherCwd = (function () {
            if (configRoot) {
                if (typeof configRoot === 'string') {
                    var resolvedPath = nPath.resolve(configRoot),
                        stat,
                        lstat;
                    try {
                        stat = fs.statSync(resolvedPath);
                        if (!stat.isDirectory()) {
                            logger.error('Error: ' + resolvedPath + ' needs to be a directory');
                            process.exit(1);
                        }

                        lstat = fs.lstatSync(resolvedPath);
                        if (lstat.isSymbolicLink() && !allowSymlinks) {
                            logger.warn(
                                boxen(
                                    'For better experience, try starting live-css' +
                                    '\nwith ' + logger.chalk.bold('--allow-symlinks') + ' parameter.',
                                    {
                                        padding: 1,
                                        margin: 1,
                                        borderStyle: 'double'
                                    }
                                )
                            );
                        }
                    } catch (e) {
                        logger.error('Error: Unable to access ' + resolvedPath);
                        process.exit(1);
                    }
                    return resolvedPath;
                } else {
                    logger.error('Error: You need to pass an absolute or relative path to the --root parameter');
                    process.exit(1);
                }
            } else {
                return process.cwd();
            }
        }());

        var defaultWatchRules = [
            '**/*.css'
            // '**/*.css.*',

            // '**/*.less',
            // '**/*.less.*',

            // '**/*.sass',
            // '**/*.sass.*',

            // '**/*.scss',
            // '**/*.scss.*',

            // An example path which is required to be watched, but its parent folder is ignored
            // See below in this file: The path also needs to be "not" ignored in the "ignored" section
            // 'node_modules/async-limiter/coverage/lcov-report/base.css',
        ];
        var watchMatchers = configuration['watch-rules'] || defaultWatchRules;

        if (inDebugMode) {
            logger.log('\n\nWatch rules:');
            logger.log(watchMatchers);
        }
        // Note:
        //     https://github.com/paulmillr/chokidar/issues/544
        //     Executable symlinks are getting watched unnecessarily due to this bug in chokidar
        var watcher = chokidar.watch(
            watchMatchers,
            {
                cwd: watcherCwd,
                // https://github.com/paulmillr/chokidar#performance
                // Sometimes the file is in the process of writing.
                // It should have a stable filesize before we notify about the change.
                awaitWriteFinish: {
                    stabilityThreshold: 100,
                    pollInterval: 45
                },
                ignored: [
                    /(^|[/\\])\../,     // A general rule to ignore the "." files/directories
                    'node_modules',

                    // An example path which is required to be watched, but its parent folder is ignored
                    // See above in this file: The path also needs to be in the watchlist section
                    '!node_modules/async-limiter/coverage/lcov-report/base.css'
                ],
                // ignored: /(^|[/\\])\../,
                // ignoreInitial: true,

                followSymlinks: allowSymlinks,

                persistent: true
            }
        );

        var flagFileWatchReady = false;
        var filesBeingWatched = [];
        var fileModifiedHandler = function (changeObj) {
            io.emit('file-modified', changeObj);
        };
        var fileAddedHandler = function (changeObj) {
            if (verboseLogging) {
                if (filesBeingWatched.length === 0) {
                    logger.success('Live CSS Editor (Magic CSS) is watching the following file(s):');
                }
                logger.log('    ' + changeObj.relativePath);
            }
            filesBeingWatched.push(changeObj);
            io.emit('file-added', changeObj);
        };
        var fileDeletedHandler = function (changeObj) {
            filesBeingWatched = filesBeingWatched.filter(function(item){
                return item.relativePath !== changeObj.relativePath;
            });

            io.emit('file-deleted', changeObj);
        };

        emitter.on('file-modified', fileModifiedHandler);
        emitter.on('file-added', fileAddedHandler);
        emitter.on('file-deleted', fileDeletedHandler);

        var anyFileNameIsRepeated = function (arrPaths) {
            var arrWithFileNames = arrPaths.map(function (item) {
                return item.fileName;
            });
            var uniqArrWithRelativePaths = _uniq(arrWithFileNames);
            if (uniqArrWithRelativePaths.length === arrWithFileNames.length) {
                return false;
            } else {
                return true;
            }
        };

        emitter.on('file-watch-ready', function () {
            flagFileWatchReady = true;
            if (!listFiles) {
                logger.log('');
            }
            logger.success(
                '\nLive CSS Editor (Magic CSS) server is ready.' +
                '\nWatching ' + filesBeingWatched.length + ' files from:' +
                '\n    ' + watcherCwd +
                '\n'
            );
            if (!configRoot && anyFileNameIsRepeated(filesBeingWatched)) {
                logger.warn(
                    boxen(
                        'Some of the files being watched have the same name.' +
                        '\nlive-css would still work fine.' +
                        '\n\nFor better experience, you may start live-css with' +
                        '\nan appropriate ' + logger.chalk.bold('--root') + ' parameter.',
                        {
                            padding: 1,
                            margin: 1,
                            borderStyle: 'double'
                        }
                    )
                );
            }
        });

        watcher.on('ready', function () {
            emitter.emit('file-watch-ready');
            // var watchedPaths = watcher.getWatched();
            // log('**********Watched paths**********');
            // log(watchedPaths);
        });


        var printSessionCount = function (connectedSessions) {
            logger.info('Number of active connections: ' + connectedSessions);
        };

        emitter.on('connected-socket', function () {
            connectedSessions++;
            logger.info('\nConnected to a socket.');
            printSessionCount(connectedSessions);
        });

        emitter.on('disconnected-socket', function () {
            connectedSessions--;
            logger.info('\nDisconnected from a socket.');
            printSessionCount(connectedSessions);
        });

        var getPathValues = function (path) {
            var ob = {
                relativePath: path,
                fullPath: nPath.join(watcherCwd, path),
                fileName: nPath.basename(path),
                useOnlyFileNamesForMatch: (function () {

                }()),
                root: watcherCwd
            };
            if (configRoot) {
                ob.root = watcherCwd;
                ob.useOnlyFileNamesForMatch = false;
            } else {
                ob.root = null;
                ob.useOnlyFileNamesForMatch = true;
            }
            return ob;
        };

        // https://github.com/paulmillr/chokidar/issues/544
        var avoidSymbolicLinkDueToChokidarBug = function (path, cb) {
            var fullPath = nPath.resolve(watcherCwd, path);
            if (allowSymlinks) {
                if (anymatch(watchMatchers, path)) {
                    cb(fullPath);
                }
            } else {
                try {
                    var lstat = fs.lstatSync(fullPath);
                    if (!lstat.isSymbolicLink()) {
                        cb(fullPath, lstat);
                    }
                } catch (e) {
                    // do nothing
                }
            }
        };

        watcher
            .on('add', function (path) {
                avoidSymbolicLinkDueToChokidarBug(path, function () {
                    if (listFiles || flagFileWatchReady) {
                        logger.verbose('Watching file: ' + path);
                    } else {
                        process.stdout.write(logger.chalk.dim('.'));
                    }
                    emitter.emit('file-added', getPathValues(path));
                });
            })
            .on('change', function (path) {
                avoidSymbolicLinkDueToChokidarBug(path, function (fullPath, lstat) {
                    var stat;
                    if (!lstat) {
                        try {
                            stat = fs.statSync(fullPath);
                        } catch (e) {
                            // do nothing
                        }
                    }

                    var timeModified = (lstat || stat || {}).mtime;

                    // mtime / timeModified / toTimeString should be available, but adding extra check to make the code more robust
                    if (timeModified && timeModified.toTimeString) {
                        timeModified = timeModified.toTimeString().substring(0, 8);
                    }
                    if (timeModified) {
                        logger.verbose('(' + timeModified + ') File modified: ' + path);
                    } else {
                        logger.verbose('File modified: ' + path);
                    }
                    emitter.emit('file-modified', getPathValues(path));
                });
            })
            .on('unlink', function (path) {
                logger.verbose('File removed: ' + path);
                emitter.emit('file-deleted', getPathValues(path));
            });

        io.on('connection', function(socket) {
            emitter.emit('connected-socket');

            // socket.on('chat message', function(msg){
            //     console.log('message: ' + msg);
            // });

            socket.on('disconnect', function(){
                emitter.emit('disconnected-socket');
            });
        });

        var startServer = function (portNumber) {
            http.listen(portNumber, function() {
                if (localIpAddressesAndHostnames.length) {
                    logger.info(
                        '\nLive CSS Editor (Magic CSS) server is available at any of the following addresses:\n' +
                        (function (localIpAddressesAndHostnames) {
                            var addresses = [].concat(localIpAddressesAndHostnames);
                            addresses = addresses.map(function (item) {
                                return  '    http://' + item + ':' + portNumber + '/';
                            });
                            return addresses.join('\n');
                        }(localIpAddressesAndHostnames)) +
                        '\n'
                    );
                }

                logger.info('Press CTRL-C to stop the server\n');

                if (listFiles || flagFileWatchReady) {
                    // do nothing
                } else {
                    if (!flagConfigurationLoaded) {
                        logger.verbose('To list the files being watched, run ' + logger.chalk.underline('live-css') + ' with ' + logger.chalk.underline('--list-files') + ' parameter.');
                    }
                    process.stdout.write(logger.chalk.dim('Adding files to watch '));
                }
            });
        };

        var portRequestedByUser = parseInt(argv.port || argv.p || configuration.port, 10),
            flagPortSetByUser = false,
            portToUse = defaultPort;
        if (
            portRequestedByUser &&
            typeof portRequestedByUser === 'number' &&
            !isNaN(portRequestedByUser) &&
            portRequestedByUser >= 1 &&
            portRequestedByUser < 65536
        ) {
            portToUse = portRequestedByUser;
            flagPortSetByUser = true;
        }

        findFreePort(portToUse, function(err, freePort) {
            if (flagPortSetByUser && freePort !== portToUse) {
                logger.warnHeading('\nPort number ' + portToUse + ' is not available. Using port number ' + freePort + '.');
            }
            startServer(freePort);
        });
    }
} else {
    logAndThrowError('Error: live-css currently does not work with Node JS require()');
}

process.on('uncaughtException', function(err) {
    if(err.code === 'EADDRINUSE') {
        logger.errorHeading('\nError: The requested port number is in use. Please pass a different port number to use.');
    } else if (err.code === 'ENOSPC') {
        logger.errorHeading(
            '\n\nError: ENOSPC'
        );
        logger.error('Exiting live-css server.');
        logger.info(
            '\nMost probably, this issue can be easily fixed. Use one of the following methods and try running live-css again:' +
            '\n    Method 1. For Linux, try following instructions mentioned at https://stackoverflow.com/questions/22475849/node-js-error-enospc/32600959#32600959' +
            '\n    Method 2. You are probably watching too many files, to fix that:' +
            '\n              - try changing "root" directory for live-css' +
            '\n              - try changing "watch-rules" if you are using live-css configuration file' +
            '\n              - try changing "watch-ignore-rules" if you are using live-css configuration file' +
            '\n    Method 3. You are probably running out of disk space. Delete some of the unnecessary files and try again' +
            '\n'
        );
    } else {
        console.log(err);
    }
    process.exit(1);
});