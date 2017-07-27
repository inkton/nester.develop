'use strict';
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import path = require('path');
import {window, commands, Disposable, ExtensionContext, StatusBarAlignment, StatusBarItem, TextDocument} from 'vscode';

var execPromise = require('child-process-promise').exec;
var exec = require('child_process').exec;
var yaml = require('yamljs');
var fs = require("fs");
var xml2js = require('xml2js');
var pathExists = require('path-exists');
var Q = require('q');

function showError(message, exception = null) : void {
    var errorMessage = message;
    if (exception != null)
    {
        errorMessage += ' [' + exception + ']';
    }
    console.error(errorMessage);
    vscode.window.showErrorMessage(errorMessage);
}

function progressStart(message) : any {
    var statusBarItem = window.createStatusBarItem(StatusBarAlignment.Left);
    statusBarItem.show();
    statusBarItem.text = message;
    console.log(message);
    return statusBarItem;
}

function progressStep(message, statusBarItem) : void {
    statusBarItem.text = message;
    console.log(message);
}

function progressStepFail(message, statusBarItem) : void {
    statusBarItem.text = message;    
    console.log(message);
    showError('Docker exec failed', message);
    statusBarItem.dispose();
}

function progressEnd(statusBarItem) : void {
    statusBarItem.text = ".";
    console.log(statusBarItem.text);
    statusBarItem.dispose();    
}

/**
 * get root folder  
 */
function getRootFolder() : string {
    const workspace = vscode.workspace;

    if (workspace && workspace.rootPath !== null)
    {        
        if (pathExists.sync(workspace.rootPath + '/docker-compose.yml'))
        {
            return workspace.rootPath;
        }
        else if (pathExists.sync(workspace.rootPath + '/nest.json'))
        {
            var nest = JSON.parse(fs.readFileSync(workspace.rootPath + '/nest.json'));
            return nest.environment['NEST_FOLDER_ROOT'];
        }
    }

    showError('Please open a folder with a valid Nest devkit first')
    return null;
}

/**
 * get nest project
 */
function getNestProject() : any {
    const workspace = vscode.workspace;
    if (workspace && workspace.rootPath !== null)
    {        
        if (pathExists.sync(workspace.rootPath + '/nest.json'))
        {
            return JSON.parse(fs.readFileSync(workspace.rootPath + '/nest.json'));
        } 
    }
    showError('Please open a folder with a valid Nest project first')
    return null;
}

/**
 * get nest services
 */
function setNestServices(statusBarItem, nestServices) : any {
    const rootFolder = getRootFolder();

    if (rootFolder !== null)
    {   
        if (pathExists.sync(rootFolder + '/app.json'))
        {
            progressStep("Saving services ... ", statusBarItem);

            var app = JSON.parse(fs.readFileSync(rootFolder + '/app.json'));
            app.docker = nestServices;

            fs.writeFile(rootFolder + '/app.json', 
                JSON.stringify(app, null, 2), 'utf-8', function(error) {

                if (error !== null) {
                    progressStepFail('app.json save failed', statusBarItem);
                    return;
                }
            });
        }
    }
}

/**
 * get nest services
 */
function getNestServices(statusBarItem) : any {
    const rootFolder = getRootFolder();

    if (rootFolder !== null)
    {       
        if (pathExists.sync(rootFolder + '/app.json'))
        {
            var app = JSON.parse(fs.readFileSync(rootFolder + '/app.json'));
            return app.docker;
        }
        else if (pathExists.sync(rootFolder + '/docker-compose.yml'))
        {
            progressStep("Found services ... ", statusBarItem);
    
            var nest = null;
            var nestServices = {};

            nestServices['names'] = [];
            nestServices['byKey'] = {};
            nestServices['app'] = null;
            nestServices['services'] = [];           
            nestServices['workers'] = [];
                            
            nest = yaml.load(rootFolder + '/docker-compose.yml');
            Object.keys(nest.services).forEach(function(key, index) {
                switch (nest.services[key].environment['NEST_PLATFORM_TAG'])
                {
                    case 'mvc':
                    case 'api':
                        nestServices['names'].push(key); 
                        nestServices['app'] = nest.services[key];         
                        nestServices['byKey'][key] = nest.services[key];
                        nestServices['byKey'][key].environment['NEST_FOLDER_ROOT'] = rootFolder;
                        progressStep("Found a handler component " + key, statusBarItem);                            
                        break;
                    case 'worker':
                        nestServices['names'].push(key);
                        nestServices['workers'].push(nest.services[key]);                                
                        nestServices['byKey'][key] = nest.services[key];
                        nestServices['byKey'][key].environment['NEST_FOLDER_ROOT'] = rootFolder;
                        progressStep("Found a worker component " + key, statusBarItem);                                                                    
                        break;
                }

                switch (nest.services[key].environment['NEST_APP_SERVICE'])
                {
                    case 'db':
                    case 'queue':                    
                        nestServices['names'].push(key); 
                        nestServices['services'] = nest.services[key];         
                        nestServices['byKey'][key] = nest.services[key];
                        nestServices['byKey'][key].environment['NEST_FOLDER_ROOT'] = rootFolder;
                        progressStep("Found a service component " + key, statusBarItem);                            
                        break;
                }                
            });

            return nestServices;
        }
        else    
        {
            progressStepFail('Failed to find a Nest docker-compose file', statusBarItem);
        }
    }
    else
    {
        progressStepFail('Failed to find a Nest docker-compose file', statusBarItem);        
    }

    return null;
}

/**
 * run nester command
 */

function runCommand(nestProject, command, statusBarItem) : any {    
    let deferred = Q.defer();

    const nestTag = nestProject.environment['NEST_TAG'];
    const nestTagCap = nestProject.environment['NEST_TAG_CAP'];        
    const nestFolder = '/source/' + nestTagCap;    
    const rootFolder = nestProject.environment['NEST_FOLDER_ROOT'];

    progressStep("Working with " + nestProject.container_name + " ...", statusBarItem);

    exec('docker exec ' + nestProject.container_name + ' nester -l /var/app/log/scaffold ' + command, 
        (error, stdout, stderr) => {

        console.log(stdout);
        console.log(stderr);      

        if (error !== null) {
            progressStepFail(stderr, statusBarItem);
            deferred.reject(nestProject);                    
            return;
        }

        progressStep(nestProject.container_name + " " + command + " OK.", statusBarItem);
        progressEnd(statusBarItem);
        deferred.resolve(nestProject);
    });

   return deferred.promise;
}

/**
 * up the project
 */
function createNestAssets(nestProject, launchConfig, statusBarItem) : any
{
    let deferred = Q.defer();

    exec('docker port ' + nestProject.container_name + '  22', (error, stdout, stderr) => {

        if (error !== null) {
            progressStepFail('Failed to get SSH port', statusBarItem);
            deferred.reject(nestProject);
            return;
        }
        
        var arr = stdout.trim().split(":");
        nestProject.environment['NEST_SSH_PORT'] = arr[1];

        const nestTag = nestProject.environment['NEST_TAG'];
        const nestTagCap = nestProject.environment['NEST_TAG_CAP'];        
        const nestFolder = '/source/' + nestTagCap;
        const nestHost = nestProject.environment['NEST_FOLDER_ROOT'] + nestFolder;

        if (!fs.existsSync(nestHost))
        {
            progressStepFail('Download failed.', statusBarItem);
            deferred.reject(nestProject);
            return;                
        }

        fs.writeFile(nestHost + '/nest.json', 
            JSON.stringify(nestProject, null, 2), 'utf-8', function(error) {

            if (error !== null) {
                progressStepFail('nest.json create failed', statusBarItem);
                deferred.reject(nestProject);
                return;
            }
        });

        progressStep("Ensured a nest project file exist, creating assets ... ", statusBarItem);

        if (!fs.existsSync(nestHost + '/.vscode'))
        {
            fs.mkdirSync(nestHost + '/.vscode');
            progressStep("Created vscode assets folder ... ", statusBarItem);                        
        }
        else
        {
            progressStep("The vscode folder exists " + nestHost + '/.vscode', statusBarItem);
        }

        var taskConfig = {
            "version": "0.1.0",
            "command": "dotnet",
            "isShellCommand": true,
            "args": [],
            "tasks": [
                {
                    "taskName": "build",
                    "args": [
                        "${workspaceRoot}/newconsole.csproj"
                    ],
                    "isBuildCommand": true,
                    "problemMatcher": "$msCompile"
                }
            ]
        }

        taskConfig.tasks[0].args[0] = "${workspaceRoot}/" + nestTagCap + ".csproj";
        
        fs.writeFile(nestHost + '/.vscode/tasks.json', 
            JSON.stringify(taskConfig, null, 2), 'utf-8', function(error) {

            progressStep("Emitting " + nestHost + '/.vscode/tasks.json', statusBarItem);        

            if (error !== null) {
                progressStepFail('Failed to create ' + nestHost + '/.vscode/tasks.json', statusBarItem);
                deferred.reject(nestProject);                
                return;
            }
        });

        const rootFolder = nestProject.environment['NEST_FOLDER_ROOT'];
        const nestShadowApp = '/var/app' + nestFolder;

        launchConfig['configurations'][0]['cwd'] = nestShadowApp;
        launchConfig['configurations'][0]['program'] = nestShadowApp;     
        launchConfig['configurations'][0].sourceFileMap = {};
        launchConfig['configurations'][0].sourceFileMap[nestShadowApp] = "${workspaceRoot}" ;
        launchConfig['configurations'][0].sourceFileMap['/var/app/source/shared'] = rootFolder + '/source/shared';

        var parser = new xml2js.Parser();
        fs.readFile(nestHost + '/' + nestTagCap + '.csproj', function(err, data) {
            parser.parseString(data, function (error, result) {

                progressStep("Emitting " + nestHost + '/.vscode/launch.json', statusBarItem);        
                                
                launchConfig['configurations'][0]['program'] +=  '/bin/Debug/' + 
                    result.Project.PropertyGroup[0].TargetFramework[0] + '/' + nestTagCap + '.dll';                
                launchConfig['configurations'][0]['pipeTransport'].pipeArgs = [
                        '-i', 
                        nestProject.environment['NEST_FOLDER_ROOT'] + '/.contact_key',
                        '-o',
                        'UserKnownHostsFile=/dev/null',
                        '-o',
                        'StrictHostKeyChecking=no', 
                        'root@' + nestProject.environment['NEST_DOCKER_MACHINE_IP'],
                        "-p",
                        nestProject.environment['NEST_SSH_PORT']
                    ];
                
                const appTag = nestProject.environment['NEST_APP_TAG'];
                const contactId = nestProject.environment['NEST_CONTACT_ID'];

                fs.writeFile(rootFolder + '/.ssh_config', 
`Host nest
HostName ${appTag}.nestapp.yt
User ${contactId}
UserKnownHostsFile ${rootFolder}/.tree_key
IdentityFile ${rootFolder}/.contact_key`, 'utf-8', function(error) {
                    if (error !== null) {
                        progressStepFail('Failed to create ' + rootFolder + '/.ssh_config', statusBarItem);
                        deferred.reject(nestProject);                
                        return;
                    }
                    
                    progressStep("Project ssh config created.", statusBarItem);        

                    var gitInit = `git config --local core.sshCommand "ssh -F ${rootFolder}/.ssh_config"  `.replace(/\\/g,"/");

                    exec(gitInit, { 'cwd' : nestHost}, 
                        (error, stdout, stderr) => {

                        console.log(stdout);
                        console.log(stderr);

                        if (error !== null) {
                            progressStepFail('Failed to init git', statusBarItem);
                            deferred.reject(nestProject);
                            return;
                        }

                        progressStep(`Project ${nestTagCap} tracks remote branch ${nestTag}-master`, statusBarItem);

                        fs.writeFile(nestHost + '/.vscode/launch.json', 
                            JSON.stringify(launchConfig, null, 2), 'utf-8', function(error) {
                            if (error !== null) {
                                progressStepFail('Failed to create ' + nestHost + '/.vscode/launch.json', statusBarItem);
                                deferred.reject(nestProject);                
                                return;
                            }

                            deferred.resolve(nestProject); 
                        });
                    });
                });
            });            
        });        
    });

   return deferred.promise;
}

/**
 * up the project
 */
function createNestProject(nestProject, statusBarItem) : any
{
    progressStep("Attaching " + nestProject.container_name + " ...", statusBarItem);
    var launchConfig = null;
    let deferred = Q.defer();

    if (nestProject.environment['NEST_PLATFORM_TAG'] === 'worker')
    {
        /* 
            Add this to see logs
                "logging": {
                    "engineLogging": true
                },
        */
        launchConfig = {
            version: '0.2.0',
            configurations: [
                {
                    "name": "Attach Nest",
                    "type": "coreclr",
                    "request": "launch",
                    "cwd": "<-fill->",
                    "program": "<-fill->",	
                    "sourceFileMap": {
                        "source" : "${workspaceRoot}"
                    },	
                    "env": {
                    },						
                    "pipeTransport": {
                        "debuggerPath": "/vsdbg/vsdbg",
                        "pipeProgram": "ssh",
                        "pipeCwd": "${workspaceRoot}",
                        "pipeArgs": [

                        ],
                        "quoteArgs": true
                    }	
                }   
            ]
        };

        launchConfig['configurations'][0].env = nestProject.environment;
        
        Object.keys(launchConfig['configurations'][0].env).forEach(function(key, index) {
            if (!isNaN(launchConfig['configurations'][0].env[key]))
            {
                launchConfig['configurations'][0].env[key] = 
                    launchConfig['configurations'][0].env[key].toString();
            }
        });

        createNestAssets(nestProject, launchConfig, statusBarItem)
            .then(function (result) {
                deferred.resolve(nestProject);
            })
            .catch(function (error) {
                deferred.reject(nestProject);
                return;
            });
    }
    else
    {
        exec('docker port ' + nestProject.container_name + '  5000', (error, stdout, stderr) => {

            if (error !== null) {
                progressStepFail('Failed to get the HTTP port', statusBarItem);
                deferred.reject(nestProject);
                return;
            }
            
            var arr = stdout.trim().split(":");
            nestProject.environment['NEST_HTTP_PORT'] = arr[1];

            /* 
                Add this to see logs
                    "logging": {
                        "engineLogging": true
                    },
            */
            launchConfig = {
                version: '0.2.0',
                configurations: [
                    {
                        "name": "Attach Nest",
                        "type": "coreclr",
                        "request": "launch",
                        "cwd": "<-fill->",
                        "program": "<-fill->",	
                        "sourceFileMap": {
                            "source" : "${workspaceRoot}"
                        },	
                        "launchBrowser": {
                            "enabled": true,
                            "args": "http://<-fill->",
                            "windows": {
                                "command": "cmd.exe",
                                "args": "/C start http://<-fill->"
                            },
                            "osx": {
                                "command": "open"
                            },
                            "linux": {
                                "command": "xdg-open"
                            }
                        },	                    
                        "env": {
                        },							
                        "pipeTransport": {
                            "debuggerPath": "/vsdbg/vsdbg",
                            "pipeProgram": "ssh",
                            "pipeCwd": "${workspaceRoot}",
                            "pipeArgs": [

                            ],
                            "quoteArgs": true
                        }	
                    }   
                ]
            };

            var browsePage = "http://" + nestProject.environment['NEST_DOCKER_MACHINE_IP'] + ":" + nestProject.environment['NEST_HTTP_PORT'];

            if (nestProject.environment['NEST_PLATFORM_TAG'] == 'api')
            {
                browsePage += "/swagger";
            }

            nestProject.environment['ASPNETCORE_ENVIRONMENT'] = "Development";
            nestProject.environment['ASPNETCORE_URLS'] = "http://*:5000";

            launchConfig['configurations'][0].launchBrowser.args = browsePage;
            launchConfig['configurations'][0].launchBrowser.windows.args = "/C start " + browsePage;            
            launchConfig['configurations'][0].env = nestProject.environment;
            
            Object.keys(launchConfig['configurations'][0].env).forEach(function(key, index) {
                if (!isNaN(launchConfig['configurations'][0].env[key]))
                {
                    launchConfig['configurations'][0].env[key] = 
                        launchConfig['configurations'][0].env[key].toString();
                }
            });

            createNestAssets(nestProject, launchConfig, statusBarItem)
                .then(function (result) {
                    deferred.resolve(nestProject);
                })
                .catch(function (error) {
                    deferred.reject(nestProject);
                    return;
                });
        });
    }

    return deferred.promise;    
}

/**
 * up the dataDown
 */
function dataDown() : any {
    const nestProject = getNestProject();
    if (nestProject === null)
        return false;

    let deferred = Q.defer();
    var statusBarItem = progressStart("Data downloading ...");

    runCommand(nestProject, "data pull", statusBarItem)
        .then(function (value) {
            progressStep('-------------------------------------', statusBarItem);
            progressStep('     The data has been downloaded    ', statusBarItem);
            progressStep('-------------------------------------', statusBarItem);
            progressStep('Help + Nest to list avaiable Nest commands.', statusBarItem);                                                
            progressEnd(statusBarItem);
            deferred.resolve(nestProject);                                                                                     
        })
        .catch(function (error) {
            deferred.reject();            
        });    

   return deferred.promise;
}

/**
 * up the dataUp
 */
function dataUp() : any {
    const nestProject = getNestProject();
    if (nestProject === null)
        return false;

    let deferred = Q.defer();
    var statusBarItem = progressStart("Data uploading ...");

    runCommand(nestProject, "data push", statusBarItem)
        .then(function (value) {
            progressStep('-------------------------------------', statusBarItem);
            progressStep('      The data has been uploaded     ', statusBarItem);
            progressStep('-------------------------------------', statusBarItem);
            progressStep('Help + Nest to list avaiable Nest commands.', statusBarItem);                                                
            progressEnd(statusBarItem);
            deferred.resolve(nestProject);                                                                                     
        })
        .catch(function (error) {
            deferred.reject();            
        });    

   return deferred.promise;
}

/**
 * up the viewData
 */
function viewData() : any {

    var statusBarItem = progressStart("Opening browser ...");    
    var nestServices = getNestServices(statusBarItem);
    if (!nestServices || nestServices['names'].length === 0)
    {
        progressStepFail('No nest projects found', statusBarItem);
        return;
    }

    var url = 'http://' + 
            nestServices['byKey']['db-mariadb'].environment['NEST_DOCKER_MACHINE_IP'] + ':' +
            nestServices['byKey']['db-mariadb'].environment['NEST_SERVICE_VIEW_PORT']

    vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(url))
}

/**
 * up the viewqueue
 */
function viewQueue() : any {

    var statusBarItem = progressStart("Opening browser ...");    
    var nestServices = getNestServices(statusBarItem);
    if (!nestServices || nestServices['names'].length === 0)
    {
        progressStepFail('No nest projects found', statusBarItem);
        return;
    }

    var url = 'http://' + 
            nestServices['byKey']['queue-rabbitmq'].environment['NEST_DOCKER_MACHINE_IP'] + ':' +
            nestServices['byKey']['queue-rabbitmq'].environment['NEST_SERVICE_VIEW_PORT']

    vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(url))
}

/**
 * up the select
 */
function select() : any {

    var statusBarItem = progressStart("Selecting ...");    
    var nestServices = getNestServices(statusBarItem);
    if (!nestServices || nestServices['names'].length === 0)
    {
        progressStepFail('No nest projects found', statusBarItem);
        return;
    }

    var nests = [];

    Object.keys(nestServices['byKey']).forEach(function(key, index) {
        if (nestServices['byKey'][key].environment['NEST_TAG'])
        {
            nests.push(key);                        
        } 
    });

    vscode.window.showQuickPick(nests)
        .then(selected => {
            if (selected)
            {
                var proj = nestServices['byKey'][selected];
                if (proj) {
                    const rootFolder = getRootFolder();                    
                    let uri = vscode.Uri.parse('file:///' + rootFolder + '/source/' + proj.environment['NEST_TAG_CAP']);
                    vscode.commands.executeCommand('vscode.openFolder', uri);   
                }
                else
                {
                    vscode.window.showErrorMessage('The source code does not exist. Ensure to scaffold first.');
                }
            }
            progressEnd(statusBarItem);
        });
}

/**
 * up the clear
 */
function clear() : any {
    const nestProject = getNestProject();
    if (nestProject === null)
        return false;

    let deferred = Q.defer();
    var statusBarItem = progressStart("Clearing ...");

    runCommand(nestProject, "app clear", statusBarItem)
        .then(function (value) {
            progressStep('-------------------------------------', statusBarItem);
            progressStep('         The project is clear       ', statusBarItem);
            progressStep('-------------------------------------', statusBarItem);
            progressStep('Help + Nest to list avaiable Nest commands.', statusBarItem);                                                
            progressEnd(statusBarItem);
            deferred.resolve(nestProject);                                                                                     
        })
        .catch(function (error) {
            deferred.reject();            
        });    

   return deferred.promise;
}

/**
 * up the clean
 */
function clean() : any {
    const nestProject = getNestProject();
    if (nestProject === null)
        return false;

    let deferred = Q.defer();
    var statusBarItem = progressStart("Cleaning ...");

    runCommand(nestProject, "app clean", statusBarItem)
        .then(function (value) {
            progressStep('-------------------------------------', statusBarItem);
            progressStep('         The project is clean       ', statusBarItem);
            progressStep('-------------------------------------', statusBarItem);
            progressStep('Help + Nest to list avaiable Nest commands.', statusBarItem);                                                
            progressEnd(statusBarItem);
            deferred.resolve(nestProject);                                                                                     
        })
        .catch(function (error) {
            deferred.reject();            
        });    

   return deferred.promise;
}

/**
 * up the reset
 */
function reset() : any {
    const nestProject = getNestProject();
    if (nestProject === null)
        return false;

    let deferred = Q.defer();
    var statusBarItem = progressStart("Restting ...");
    const rootFolder = getRootFolder();

    exec('docker-compose up -d', { 'cwd' : rootFolder }, 
        (error, stdout, stderr) => {

        console.log(stdout);
        console.log(stderr);
        
        if (error !== null) {
            progressStepFail(stderr, statusBarItem);
            deferred.reject(nestProject);                
            return;
        }

        progressStep("Downloading the source ...", statusBarItem);

        createNestProject(nestProject, statusBarItem)
            .then(function (value) {
                progressStep('-------------------------------------', statusBarItem);
                progressStep('        The project reset ended      ', statusBarItem);
                progressStep('-------------------------------------', statusBarItem);
                progressStep('Help + Nest to list avaiable Nest commands.', statusBarItem);                                                
                progressEnd(statusBarItem);
                deferred.resolve(nestProject);            
            })
            .catch(function (error) {
                deferred.reject();            
            });   
    });   

   return deferred.promise;
}

/**
 * up the build
 */
function restore() : any { 
    const nestProject = getNestProject();
    if (nestProject === null)
        return false;

    let deferred = Q.defer();
    var statusBarItem = progressStart("Restoring ...");

    runCommand(nestProject, "app restore", statusBarItem)
        .then(function (value) {
            progressStep('-------------------------------------', statusBarItem);
            progressStep('       The project restore ended    ', statusBarItem);
            progressStep('-------------------------------------', statusBarItem);
            progressStep('Help + Nest to list avaiable Nest commands.', statusBarItem);                                                
            progressEnd(statusBarItem);
            deferred.resolve(nestProject);                                                                                     
        })
        .catch(function (error) {
            deferred.reject();            
        });    

   return deferred.promise;
}

/**
 * up the build
 */
function build() : any { 
    const nestProject = getNestProject();
    if (nestProject === null)
        return false;

    let deferred = Q.defer();
    var statusBarItem = progressStart("Building ...");

    runCommand(nestProject, "app build", statusBarItem)
        .then(function (value) {
            progressStep('-------------------------------------', statusBarItem);
            progressStep('       The project build ended    ', statusBarItem);
            progressStep('-------------------------------------', statusBarItem);
            progressStep('Help + Nest to list avaiable Nest commands.', statusBarItem);                                                
            progressEnd(statusBarItem);
            deferred.resolve(nestProject);            
        })
        .catch(function (error) {
            deferred.reject();                            
        });

   return deferred.promise;        
}

/**
 * up the publish
 */
function publish() : any { 
    const nestProject = getNestProject();
    if (nestProject === null)
        return false;

    let deferred = Q.defer();
    var statusBarItem = progressStart("Publishing ...");

    runCommand(nestProject, "deployment publish", statusBarItem)
        .then(function (value) {
            progressStep('-------------------------------------', statusBarItem);
            progressStep('       The project publish ended    ', statusBarItem);
            progressStep('-------------------------------------', statusBarItem);
            progressStep('Help + Nest to list avaiable Nest commands.', statusBarItem);                                                
            progressEnd(statusBarItem);
            deferred.resolve(nestProject);            
        })
        .catch(function (error) {
            deferred.reject();                            
        });

   return deferred.promise;        
}

/**
 * up the scaffold nesst
 */
function scaffoldNest(nestServices, key, dockerMachineIP, statusBarItem, rootFolder) : any 
{
    let deferred = Q.defer();

    nestServices['byKey'][key].environment['NEST_DOCKER_MACHINE_IP'] = dockerMachineIP;
    progressStep("Attaching " + nestServices['byKey'][key].container_name + ", this may take a minute or two ...", statusBarItem);

    execPromise('docker exec ' + nestServices['byKey'][key].container_name + ' nester app attach')
        .then(function (result) {
            
            progressStep("Attach ok ..., creating project " + nestServices['byKey'][key].container_name, statusBarItem);

            createNestProject(nestServices['byKey'][key], statusBarItem)
                .then(function (result) {
                
                progressStep("Project " + nestServices['byKey'][key].container_name + " created, now restoring ...", statusBarItem); 
                
                runCommand(nestServices['byKey'][key], "app restore", statusBarItem)
                    .then(function (value) {

                        progressStep("Project " + nestServices['byKey'][key].container_name + " created, now building ...", statusBarItem); 
                        
                        runCommand(nestServices['byKey'][key], "app build", statusBarItem)
                            .then(function (value) {
                                // done!
                                deferred.resolve(nestServices);
                            })
                            .catch(function (error) {
                                progressStepFail(nestServices['byKey'][key].container_name + ' project build failed', statusBarItem);
                                deferred.reject(nestServices);
                            });
                    })
                    .catch(function (error) {
                        progressStepFail(nestServices['byKey'][key].container_name + ' project restore failed', statusBarItem);
                        deferred.reject(nestServices);
                    });                                            
                })
                .catch(function (error) {
                    progressStepFail(nestServices['byKey'][key].container_name + ' project create failed', statusBarItem);
                    deferred.reject(nestServices);
                    return;
                });

        })
        .catch(function (error) {
            progressStepFail('Attach failed', statusBarItem);
            deferred.reject(nestServices);
            return;
        });

    return deferred;    
}

/**
 * up the scaffold nesst
 */
function scaffoldService(nestServices, key, dockerMachineIP, statusBarItem, rootFolder) : any 
{
    let deferred = Q.defer();

    nestServices['byKey'][key].environment['NEST_DOCKER_MACHINE_IP'] = dockerMachineIP;
    progressStep("Discovering " + nestServices['byKey'][key].container_name + " ports, this may take a minute or two ...", statusBarItem);
    
    var viewPort = '';
    if (key === 'db-mariadb')
    {
        viewPort = ' 80';
    }
    else if (key === 'queue-rabbitmq')
    {
        viewPort = ' 15672';
    }

    exec('docker port ' + nestServices['byKey'][key].container_name + viewPort, (error, stdout, stderr) => {

        if (error !== null) {
            progressStepFail('Failed to get view port', statusBarItem);
            deferred.reject(nestServices);
            return;
        }

        progressStep("Port found ... saving info on " + nestServices['byKey'][key].container_name, statusBarItem);
        var arr = stdout.trim().split(":");
        nestServices['byKey'][key].environment['NEST_SERVICE_VIEW_PORT'] = arr[1];
        // done!
        deferred.resolve(nestServices);
    });

    return deferred;    
}

/**
 * up the scaffold
 */
function scaffold() : any {    

    const rootFolder = getRootFolder();
    if (!getRootFolder)
    {
        return;
    }

    if (fs.existsSync(rootFolder + '/source'))
    {
        vscode.window.showErrorMessage('A scaffold already exist. Remove all files/folders except the devkit file before proceeding.');
        return;                
    }

    var statusBarItem = progressStart("Scaffolding ...");
    let deferred = Q.defer();

    var nestServices = getNestServices(statusBarItem);
    if (!nestServices || nestServices['names'].length === 0)
    {
        progressStepFail('No nest projects found', statusBarItem);
        deferred.reject();        
        return;
    }

    exec('docker-machine ip', 
        (error, stdout, stderr) => {

        if (error !== null) {
            progressStepFail(stderr, statusBarItem);
            deferred.reject();                
            return;
        }

        var dockerMachineIP = stdout.trim();

        progressStep("Docker IP is ... " + dockerMachineIP, statusBarItem);
        progressStep("Composing docker containers", statusBarItem);
        progressStep("The docker images will be downloaded and built", statusBarItem);        
        progressStep("This may take a while, please wait ...", statusBarItem);

        exec('docker-compose down', { 'cwd' : rootFolder }, 
            (error, stdout, stderr) => {
            
            exec('docker-compose up -d', { 'cwd' : rootFolder }, 
                (error, stdout, stderr) => {

                console.log(stdout);
                console.log(stderr);
                
                if (error !== null) {
                    progressStepFail(stderr, statusBarItem);
                    deferred.reject(nestServices);                
                    return;
                }

                var services = [];

                Object.keys(nestServices['byKey']).forEach(function(key, index) {
                    if (nestServices['byKey'][key].environment['NEST_TAG'])
                    {
                        progressStep("Downloading the source ...", statusBarItem);
                        services.push(scaffoldNest(nestServices, key, dockerMachineIP, statusBarItem, rootFolder).promise);                        
                    } 
                    else if (nestServices['byKey'][key].environment['NEST_APP_SERVICE'])
                    {
                        progressStep("Discovering services ...", statusBarItem);
                        services.push(scaffoldService(nestServices, key, dockerMachineIP, statusBarItem, rootFolder).promise);                        
                    }                    
                });
                
                Q.all(services).done(function (values) {
                    progressStep("Setting shared area upstream.", statusBarItem);
                    var gitInit = `git config --local core.sshCommand "ssh -F ${rootFolder}/.ssh_config" && `.replace(/\\/g,"/");
                    gitInit += " git fetch &&";
                    gitInit += ` git branch --set-upstream-to=origin/shared-master shared-master`;
                    var sharedFolder = rootFolder + "/source/shared";

                    exec(gitInit, { 'cwd' : sharedFolder}, 
                        (error, stdout, stderr) => {

                        console.log(stdout);
                        console.log(stderr);

                        if (error !== null) {
                            progressStepFail('Failed to init git', statusBarItem);
                            deferred.reject(nestServices);
                            return;
                        }

                        setNestServices(statusBarItem, nestServices);
                        deferred.resolve(nestServices);
                        progressStep('-------------------------------------', statusBarItem);
                        progressStep('      The scaffold is in place       ', statusBarItem);
                        progressStep('-------------------------------------', statusBarItem);
                        progressStep('Help + Nest to list avaiable Nest commands.', statusBarItem);                                                
                        progressEnd(statusBarItem);                        
                    }); 
                });
            });
        });    
    });
    
   return deferred.promise;
}

/**
 * up the help
 */
function help() : any { 

    console.log('-------------------------------------');
    console.log('            Nest Commands            ');
    console.log('-------------------------------------');
    console.log('Nest Select, to Select a project.');    
    console.log('Nest Data Up, to upload data to production.');
    console.log('Nest Data Down, to download data into test.');
    console.log('Nest View Data, to view test data.');
    console.log('Nest View Queue, to view test queue.');         
    console.log('Nest Restore, to restore the project.');
    console.log('Nest Build, to build the project.');
    console.log('Nest Clean, to clean the output.');
    console.log('Nest Clear, to remove output folders.');
    console.log('Nest Remap, to recapture ports.');
    console.log('Nest Publish, to publish in production.');
    console.log('Nest Scaffold, to build assets when new or updated.');
    console.log('Use git push to archive the code.');                                       
}

function showProgress(op) : any { 
    vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: '+'}, p => {
        return new Promise((resolve, reject) => {
            return op()
            .then(function () {
                // Success!!
                resolve();
            }, function (err) {
                // There was an error, and we get the reason for error 
                reject();
            });
        });
    });
}

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

    // Use the console to output diagnostic information (console.log) and errors (console.error)
    // This line of code will only be executed once when your extension is activated
    console.log('Congratulations, your extension "inkton-nest" is now active!');

    try {
        var workspace = vscode.workspace;
        var config = workspace.getConfiguration('omnisharp');
        config.update('path', 'Nope');
        
        let dataUpDisposable = vscode.commands.registerCommand('extension.inkton-nest.dataup', () => { return showProgress(dataUp); });
        let dataDownDisposable = vscode.commands.registerCommand('extension.inkton-nest.datadown', () => { return showProgress(dataDown); });
        let viewdataDisposable = vscode.commands.registerCommand('extension.inkton-nest.viewdata', () => viewData());
        let viewqueueDisposable = vscode.commands.registerCommand('extension.inkton-nest.viewqueue', () => viewQueue());              
        let publishDisposable = vscode.commands.registerCommand('extension.inkton-nest.publish', () => { return showProgress(publish) });
        let selectDisposable = vscode.commands.registerCommand('extension.inkton-nest.select', () => select( ) );
        let cleanDisposable = vscode.commands.registerCommand('extension.inkton-nest.clean', () => { return showProgress(clean) });      
        let clearDisposable = vscode.commands.registerCommand('extension.inkton-nest.clear', () => { return showProgress(clear) });              
        let resetDisposable = vscode.commands.registerCommand('extension.inkton-nest.reset', () => { return showProgress(reset) });
        let buildDisposable = vscode.commands.registerCommand('extension.inkton-nest.build', () => { return showProgress(build) });
        let helpDisposable = vscode.commands.registerCommand('extension.inkton-nest.help', () => help( ) );        
        let restoreDisposable = vscode.commands.registerCommand('extension.inkton-nest.restore', () => { return showProgress(restore) });        
        let scaffoldDisposable = vscode.commands.registerCommand('extension.inkton-nest.scaffold', () =>
            execPromise('git --version')
                .then(function (result) {
                    var stdout = result.stdout;
                    var thenum = stdout.replace( /^\D+/g, '').split(".");
                    // local ssh support is needed with git v2.10 
                    if (parseInt(thenum[0], 10) <= 2)
                    {
                        if (parseInt(thenum[1], 10) <= 10)
                        {
                            showError("Please install Git vesion 2.10 or greater");
                            return;
                        }                        
                    }
                    
                    return showProgress(scaffold);
                })
                .catch(function (exception) {
                    showError("Failed to check if Git is installed");
                })   
        );

        context.subscriptions.push(dataUpDisposable);
        context.subscriptions.push(dataDownDisposable);
        context.subscriptions.push(viewdataDisposable);
        context.subscriptions.push(viewqueueDisposable);        
        context.subscriptions.push(publishDisposable);
        context.subscriptions.push(selectDisposable);
        context.subscriptions.push(cleanDisposable);
        context.subscriptions.push(clearDisposable);        
        context.subscriptions.push(resetDisposable);
        context.subscriptions.push(buildDisposable);   
        context.subscriptions.push(restoreDisposable);                  
        context.subscriptions.push(scaffoldDisposable);
        context.subscriptions.push(helpDisposable);

    } catch( exception ) {
        showError("Sorry, something went wrong with Nest services", exception);
    }
}

// this method is called when your extension is deactivated
export function deactivate() {
    
}