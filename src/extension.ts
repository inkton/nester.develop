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
var glob = require('glob-fs')({ gitignore: true });
var Q = require('q');
var process = require('process');
var accents = require('remove-accents');

var notifier: {
    subject : string,
    statusBar : any; 
    outputChannel : any;
}

function createNotifiers() : void {
    var statusBarItem = window.createStatusBarItem(StatusBarAlignment.Left);
    statusBarItem.show();

    var myOutputChannel = vscode.window.createOutputChannel('nester.develop');
    myOutputChannel.show();    

    notifier = { subject : "", statusBar: statusBarItem,  outputChannel: myOutputChannel };        
}

function destroyNotifiers() : void {
    notifier.statusBar.dispose();
    notifier.outputChannel.dispose();            
}

function showError(message, exception = null) : void {
    var errorMessage = message;
    if (exception != null)
    {
        errorMessage += ' [' + exception + ']';
    }
    console.error(errorMessage);
    vscode.window.showErrorMessage(errorMessage);
    notifier.outputChannel(errorMessage);
}

function progressStart(message) : any {
    notifier.subject = message;    
    var output = "Begin " + message + " -->";
    notifier.statusBar.text = output;    
    notifier.outputChannel.clear();
    notifier.outputChannel.appendLine(output);    
    console.log(output);    
    return notifier;
}

function progressStep(message, progressMarker) : void {
    var output = message + ".\n";
    notifier.statusBar.text = output;
    notifier.outputChannel.append(output);    
    console.log(message);
}

function progressStepFail(message, progressMarker) : void {
    var output = "<-- " + notifier.subject + " failed \n[ " + message + " ]";    
    progressMarker.statusBar.text = output;
    progressMarker.outputChannel.appendLine(output);        
    console.log(output);
}

function progressEnd(progressMarker) : void {
    var output = "<-- " + notifier.subject + " ended";        
    notifier.outputChannel.appendLine(output);    
    notifier.outputChannel.appendLine("'Nest Help' lists avaiable Nest commands");   
}

/**
 * get file set
 */
function fileSet(cwd, path) : any {
    try
    {
        process.chdir(cwd);
        return glob.readdirSync(path);    
    } catch (e) {
        return [];
    }
}

function isNestProject(folder) : Boolean {
    try
    {
        return fs.existsSync(folder + '/nest.json');
    } catch (e) {
        return false;
    }
}

function hasScaffold(folder) : Boolean {
    try
    {
        return fs.existsSync(folder + '/settings.json');
    } catch (e) {
        return false;
    }
}

function devkit(folder) : string {
    try
    {
        var files = fileSet(folder, '*.devkit'); 
        if (files.length !== 0)
        {
            return files[0];
        }        
    } catch (e) {
    }
    return null;
}

function getRootFolder() : string {
    const workspace = vscode.workspace;

    if (workspace && workspace.rootPath !== null)
    {       
        if (devkit(workspace.rootPath) !== null)
        {
            return workspace.rootPath;
        }
        else if (isNestProject(workspace.rootPath))
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
        if (isNestProject(workspace.rootPath))
        {
            return JSON.parse(fs.readFileSync(workspace.rootPath + '/nest.json'));
        } 
    }
    showError('Please open a folder with a valid Nest project first')
    return null;
}

/**
 * get nest settings
 */
function setNestSettings(progressMarker, nestSettings) : any {
    const rootFolder = getRootFolder();

    if (rootFolder !== null)
    {   
        progressStep("Saving settings ... ", progressMarker);
        
        fs.writeFile(rootFolder + '/settings.json', 
            JSON.stringify(nestSettings, null, 2), 'utf-8', function(error) {

            if (error !== null) {
                progressStepFail('settings.json save failed', progressMarker);
                return;
            }
        });
    }
}

/**
 * get nest settings
 */
function getNestSettings(progressMarker) : any {
    const rootFolder = getRootFolder();

    if (rootFolder !== null)
    {  
        if (hasScaffold(rootFolder))
        {
            var settings = JSON.parse(fs.readFileSync(rootFolder + '/settings.json'));
            return settings;
        }
        else if (devkit(rootFolder) !== null)
        {
            progressStep("Found services ... ", progressMarker);
    
            var nest = null;
            var nestSettings = {};

            nestSettings['names'] = [];
            nestSettings['byKey'] = {};
            nestSettings['app'] = null;
            nestSettings['services'] = [];           
            nestSettings['workers'] = [];
                            
            nest = yaml.load(rootFolder + '/' + devkit(rootFolder));
            Object.keys(nest.services).forEach(function(key, index) {
                switch (nest.services[key].environment['NEST_PLATFORM_TAG'])
                {
                    case 'mvc':
                    case 'api':
                        nestSettings['names'].push(key); 
                        nestSettings['app'] = nest.services[key];         
                        nestSettings['byKey'][key] = nest.services[key];
                        nestSettings['byKey'][key].environment['NEST_FOLDER_ROOT'] = rootFolder;
                        progressStep("Found a handler component " + key, progressMarker);                            
                        break;
                    case 'worker':
                        nestSettings['names'].push(key);
                        nestSettings['workers'].push(nest.services[key]);                                
                        nestSettings['byKey'][key] = nest.services[key];
                        nestSettings['byKey'][key].environment['NEST_FOLDER_ROOT'] = rootFolder;
                        progressStep("Found a worker component " + key, progressMarker);                                                                    
                        break;
                }

                switch (nest.services[key].environment['NEST_APP_SERVICE'])
                {
                    case 'db':
                    case 'queue':                    
                        nestSettings['names'].push(key); 
                        nestSettings['services'] = nest.services[key];         
                        nestSettings['byKey'][key] = nest.services[key];
                        nestSettings['byKey'][key].environment['NEST_FOLDER_ROOT'] = rootFolder;
                        progressStep("Found a service component " + key, progressMarker);                            
                        break;
                }                
            });

            return nestSettings;
        }
        else    
        {
            progressStepFail('Failed to find a Nest docker-compose file', progressMarker);
        }
    }
    else
    {
        progressStepFail('Failed to find a Nest docker-compose file', progressMarker);        
    }

    return null;
}

/**
 * run nester command
 */

function runCommand(nestProject, command, progressMarker) : any {    
    let deferred = Q.defer();

    const nestTag = nestProject.environment['NEST_TAG'];
    const nestTagCap = nestProject.environment['NEST_TAG_CAP'];        
    const nestFolder = '/source/' + nestTagCap;    
    const rootFolder = nestProject.environment['NEST_FOLDER_ROOT'];

    progressStep("Working with " + nestProject.container_name + " ...", progressMarker);

    exec('docker exec ' + nestProject.container_name + ' nester -l /tmp/scaffold ' + command, 
        (error, stdout, stderr) => {
            
        if (stdout !== null)
        {
            progressStep(stdout, progressMarker);            
        }        
        if (error !== null) {
            progressStep("Ensure docker is installed and is accessible from this environment", progressMarker); 
            progressStep("Run <Nest Reset> command if docker containers are not running", progressMarker);             
            progressStepFail(stderr, progressMarker);
            deferred.reject(nestProject);                    
            return;
        }

        progressStep(nestProject.container_name + " " + command + " OK", progressMarker);
        deferred.resolve(nestProject);
    });

   return deferred.promise;
}

/**
 * up the project
 */
function createNestAssets(nestProject, launchConfig, progressMarker) : any
{
    let deferred = Q.defer();

    exec('docker port ' + nestProject.container_name + '  22', (error, stdout, stderr) => {

        if (error !== null) {
            progressStep("Ensure docker is installed and is accessible from this environment", progressMarker);       
            progressStepFail(stderr, progressMarker);
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
            progressStepFail('Download failed.', progressMarker);
            deferred.reject(nestProject);
            return;                
        }

        fs.writeFile(nestHost + '/nest.json', 
            JSON.stringify(nestProject, null, 2), 'utf-8', function(error) {

            if (error !== null) {
                progressStepFail('nest.json create failed', progressMarker);
                deferred.reject(nestProject);
                return;
            }
        });

        progressStep("Ensured a nest project file exist, creating assets ... ", progressMarker);

        if (!fs.existsSync(nestHost + '/.vscode'))
        {
            fs.mkdirSync(nestHost + '/.vscode');
            progressStep("Created vscode assets folder ... ", progressMarker);                        
        }
        else
        {
            progressStep("The vscode folder exists " + nestHost + '/.vscode', progressMarker);
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

            progressStep("Emitting " + nestHost + '/.vscode/tasks.json', progressMarker);        

            if (error !== null) {
                progressStepFail('Failed to create ' + nestHost + '/.vscode/tasks.json', progressMarker);
                deferred.reject(nestProject);                
                return;
            }
        });

        var projSettings = {
            "omnisharp.path": "Nope"
        };        

        fs.writeFile(nestHost + '/.vscode/settings.json', 
            JSON.stringify(projSettings, null, 2), 'utf-8', function(error) {

            progressStep("Emitting " + nestHost + '/.vscode/settings.json', progressMarker);        

            if (error !== null) {
                progressStepFail('Failed to create ' + nestHost + '/.vscode/settings.json', progressMarker);
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
                        
                progressStep("Emitting " + nestHost + '/.vscode/launch.json', progressMarker);        
                                
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
                        progressStepFail('Failed to create ' + rootFolder + '/.ssh_config', progressMarker);
                        deferred.reject(nestProject);                
                        return;
                    }
                    
                    progressStep("Project ssh config created.", progressMarker);        

                    var gitInit = `git config --local core.sshCommand "ssh -F ${rootFolder}/.ssh_config" && git config --local core.fileMode false`.replace(/\\/g,"/");
                    
                    exec(gitInit, { 'cwd' : nestHost.replace(/\\/g,"/")}, 
                        (error, stdout, stderr) => {

                        if (stdout !== null)
                        {
                            progressStep(stdout, progressMarker);            
                        }         
                                        
                        if (error !== null) {
                            progressStepFail(stderr, progressMarker);
                            deferred.reject(nestProject);
                            return;
                        }

                        progressStep(`Project ${nestTagCap} tracks remote branch ${nestTag}-master`, progressMarker);

                        fs.writeFile(nestHost + '/.vscode/launch.json', 
                            JSON.stringify(launchConfig, null, 2), 'utf-8', function(error) {
                            if (error !== null) {
                                progressStepFail('Failed to create ' + nestHost + '/.vscode/launch.json', progressMarker);
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
function createNestProject(nestProject, progressMarker) : any
{
    progressStep("Attaching " + nestProject.container_name + " ...", progressMarker);
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
        var value;

        Object.keys(launchConfig['configurations'][0].env).forEach(function(key, index) {
            if (!isNaN(launchConfig['configurations'][0].env[key]))
            {
                value = launchConfig['configurations'][0].env[key].toString();
            }
            else
            {
                value = accents.remove(launchConfig['configurations'][0].env[key].toString()); 
            }            
            launchConfig['configurations'][0].env[key] = value;        
        });

        createNestAssets(nestProject, launchConfig, progressMarker)
            .then(function (result) {
                deferred.resolve(nestProject);
            })
            .catch(function (error) {
                progressStepFail(error, progressMarker);
                deferred.reject(nestProject);
                return;
            });
    }
    else
    {
        exec('docker port ' + nestProject.container_name + '  5000', (error, stdout, stderr) => {

            if (error !== null) {
                progressStep("Ensure docker is installed and is accessible from this environment", progressMarker);                
                progressStepFail(stderr, progressMarker);
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
                    value = launchConfig['configurations'][0].env[key].toString();
                }
                else
                {
                    value = accents.remove(launchConfig['configurations'][0].env[key].toString()); 
                }
                launchConfig['configurations'][0].env[key] = value;
            });

            createNestAssets(nestProject, launchConfig, progressMarker)
                .then(function (result) {
                    deferred.resolve(nestProject);
                })
                .catch(function (error) {
                    progressStepFail(error, progressMarker);
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
    var progressMarker = progressStart("data download");

    let quickPick = ['yes', 'no'];
    vscode.window.showQuickPick(quickPick, { placeHolder: 'Replace local Database from production?' }).then((val) => {
        if (val) {
            if (val === 'yes')
            {
                runCommand(nestProject, "data pull", progressMarker)
                .then(function (value) {
                    progressEnd(progressMarker);
                    deferred.resolve(nestProject);
                })
                .catch(function (error) {
                    progressStepFail(error, progressMarker); 
                    deferred.reject();            
                });                
            }
        } else {
            return
        }
    })

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
    var progressMarker = progressStart("data upload");

    runCommand(nestProject, "data push", progressMarker)
        .then(function (value) {
            progressEnd(progressMarker);
            deferred.resolve(nestProject);
        })
        .catch(function (error) {
            progressStepFail(error, progressMarker);
            deferred.reject();           
        });    

   return deferred.promise;
}

/**
 * up the viewData
 */
function viewData() : any {

    var progressMarker = progressStart("view data");    
    var nestSettings = getNestSettings(progressMarker);
    if (!nestSettings || nestSettings['names'].length === 0)
    {
        progressStepFail('No nest projects found', progressMarker);
        return;
    }

    var url = 'http://' + 
            nestSettings['byKey']['db-mariadb'].environment['NEST_DOCKER_MACHINE_IP'] + ':' +
            nestSettings['byKey']['db-mariadb'].environment['NEST_SERVICE_VIEW_PORT']

    vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(url));

    progressEnd(progressMarker);
}

/**
 * up the viewqueue
 */
function viewQueue() : any {

    var progressMarker = progressStart("view queue");    
    var nestSettings = getNestSettings(progressMarker);
    if (!nestSettings || nestSettings['names'].length === 0)
    {
        progressStepFail('No nest projects found', progressMarker);
        return;
    }

    var url = 'http://' + 
            nestSettings['byKey']['queue-rabbitmq'].environment['NEST_DOCKER_MACHINE_IP'] + ':' +
            nestSettings['byKey']['queue-rabbitmq'].environment['NEST_SERVICE_VIEW_PORT']

    vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(url));

    progressEnd(progressMarker);
}

/**
 * up the select
 */
function select() : any {

    var progressMarker = progressStart("select project");    
    var nestSettings = getNestSettings(progressMarker);
    if (!nestSettings || nestSettings['names'].length === 0)
    {
        progressStepFail('No nest projects found', progressMarker);
        return;
    }

    var nests = [];

    Object.keys(nestSettings['byKey']).forEach(function(key, index) {
        if (nestSettings['byKey'][key].environment['NEST_TAG'])
        {
            nests.push(key);                        
        } 
    });

    vscode.window.showQuickPick(nests)
        .then(selected => {
            if (selected)
            {
                var proj = nestSettings['byKey'][selected];
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
            progressEnd(progressMarker);
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
    var progressMarker = progressStart("clear");

    runCommand(nestProject, "deployment clear", progressMarker)
        .then(function (value) {
            progressEnd(progressMarker);
            deferred.resolve(nestProject);            
        })
        .catch(function (error) {
            progressStepFail(error, progressMarker);
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
    var progressMarker = progressStart("cleaning");

    runCommand(nestProject, "deployment clean", progressMarker)
        .then(function (value) {
            progressEnd(progressMarker);
            deferred.resolve(nestProject);            
        })
        .catch(function (error) {
            progressStepFail(error, progressMarker);
            deferred.reject();            
        });    

   return deferred.promise;
}

/**
 * up the reset
 */
function reset() : any 
{
    const nestProject = getNestProject();
    if (nestProject === null)
        return false;

    var nestSettings = getNestSettings(progressMarker);
    if (!nestSettings || nestSettings['names'].length === 0)
    {
        progressStepFail('No nest projects found', progressMarker);
        return;
    }
    
    let deferred = Q.defer();
    var progressMarker = progressStart("reset");
    const rootFolder = getRootFolder();

    exec('docker-machine ip', 
        (error, stdout, stderr) => {

        var dockerMachineIP = "127.0.0.1";
        
        if (error !== null) 
        {
            progressStep("docker-machine ip did not resolve docker ip.. using localhost", progressMarker);            
        }
        else
        {
            dockerMachineIP = stdout.trim();            
        }

        var services = [];

        Object.keys(nestSettings['byKey']).forEach(function(key, index) {
            if (nestSettings['byKey'][key].environment['NEST_APP_SERVICE'])
            {
                progressStep("Discovering services ...", progressMarker);                
                services.push(scaffoldService(nestSettings, key, dockerMachineIP, progressMarker, rootFolder).promise);                        
            }                    
        });

        Q.all(services).done(function (values) {
            progressStep("Setting shared services.", progressMarker);            
            setNestSettings(progressMarker, nestSettings);

            exec('docker-compose --file '+ nestProject.environment['NEST_APP_TAG'] +'.devkit up -d', { 'cwd' : rootFolder }, 
                (error, stdout, stderr) => {

                if (error !== null) {
                    progressStep("Ensure docker is installed and is accessible from this environment", progressMarker);                                               
                    progressStepFail(stderr, progressMarker);
                    deferred.reject(nestProject);                
                    return;
                }

                if (stdout !== null)
                {
                    progressStep(stdout, progressMarker);            
                }
                
                progressStep("Downloading the source ...", progressMarker);

                createNestProject(nestProject, progressMarker)
                    .then(function (value) {
                        progressEnd(progressMarker);
                        deferred.resolve(nestProject);            
                    })
                    .catch(function (error) {
                        progressStepFail(error, progressMarker);
                        deferred.reject();
                    });   
            });   
        });
    });

   return deferred.promise;
}

/**
 * up the kill
 */
function kill() : any {
    const nestProject = getNestProject();
    if (nestProject === null)
        return false;

    let deferred = Q.defer();
    var progressMarker = progressStart("kill");

    runCommand(nestProject, "nests kill", progressMarker)
        .then(function (value) {
            progressEnd(progressMarker);
            deferred.resolve(nestProject);            
        })
        .catch(function (error) {
            progressStepFail(error, progressMarker);
            deferred.reject();            
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
    var progressMarker = progressStart("restore");

    runCommand(nestProject, "deployment restore", progressMarker)
        .then(function (value) {
            progressEnd(progressMarker);
            deferred.resolve(nestProject);           
        })
        .catch(function (error) {
            progressStepFail(error, progressMarker);
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
    var progressMarker = progressStart("building");

    runCommand(nestProject, "deployment build", progressMarker)
        .then(function (value) {
            progressEnd(progressMarker);
            deferred.resolve(nestProject);            
        })
        .catch(function (error) {
            progressStepFail(error, progressMarker);
            deferred.reject();            
        });

   return deferred.promise;        
}

/**
 * up the pull
 */
function pull() : any { 
    const nestProject = getNestProject();
    if (nestProject === null)
        return false;

    let deferred = Q.defer();
    var progressMarker = progressStart("pull content");
            
    let quickPick = ['yes', 'no'];
    vscode.window.showQuickPick(quickPick, { placeHolder: 'Replace local content from production?' }).then((val) => {
        if (val) {
            if (val === 'yes')
            {
                runCommand(nestProject, "deployment pull", progressMarker)
                .then(function (value) {

                    progressStep("Re-create project ...", progressMarker);
                    
                    createNestProject(nestProject, progressMarker)
                        .then(function (value) {
                            progressEnd(progressMarker);                            
                            deferred.resolve(nestProject);
                        })
                        .catch(function (error) {
                            progressStepFail(error, progressMarker);                            
                            deferred.reject();
                        });   
                })
                .catch(function (error) {
                    progressStepFail(error, progressMarker);                            
                    deferred.reject();                     
                });        
            }
        } else {
            return
        }
    })

   return deferred.promise;        
}


/**
 * up the push
 */
function push() : any { 
    const nestProject = getNestProject();
    if (nestProject === null)
        return false;

    let deferred = Q.defer();
    var progressMarker = progressStart("publish");

    runCommand(nestProject, "deployment push", progressMarker)
        .then(function (value) {
            progressEnd(progressMarker);
            deferred.resolve(nestProject);            
        })
        .catch(function (error) {
            progressStepFail(error, progressMarker);            
            deferred.reject();            
        });

   return deferred.promise;        
}

/**
 * up the scaffold nesst
 */
function scaffoldNest(nestSettings, key, dockerMachineIP, progressMarker, rootFolder) : any 
{
    let deferred = Q.defer();

    nestSettings['byKey'][key].environment['NEST_DOCKER_MACHINE_IP'] = dockerMachineIP;
    progressStep("Attaching " + nestSettings['byKey'][key].container_name + ", this may take a minute or two ...", progressMarker);

    runCommand(nestSettings['byKey'][key], "app attach", progressMarker)
        .then(function (result) {
            
            progressStep("Attach ok ... pulling from production " + nestSettings['byKey'][key].container_name, progressMarker);

            runCommand(nestSettings['byKey'][key], "deployment pull", progressMarker)
                .then(function (value) {

                progressStep("Code for " + nestSettings['byKey'][key].container_name + " deployment downloaded", progressMarker);

                createNestProject(nestSettings['byKey'][key], progressMarker)
                    .then(function (result) {
                    
                    progressStep("Project " + nestSettings['byKey'][key].container_name + " created, now restoring ...", progressMarker); 
                    
                    runCommand(nestSettings['byKey'][key], "deployment restore", progressMarker)
                        .then(function (value) {

                            progressStep("Project " + nestSettings['byKey'][key].container_name + " created, now building ...", progressMarker); 
                            
                            runCommand(nestSettings['byKey'][key], "deployment build", progressMarker)
                                .then(function (value) {
                                    // done!
                                    deferred.resolve(nestSettings);
                                })
                                .catch(function (error) {
                                    progressStepFail(nestSettings['byKey'][key].container_name + ' project build failed [' + error + ']', progressMarker);
                                    deferred.reject(nestSettings);
                                });
                        })
                        .catch(function (error) {
                            progressStepFail(nestSettings['byKey'][key].container_name + ' project restore failed [' + error + ']', progressMarker);
                            deferred.reject(nestSettings);
                        });                                            
                    })
                    .catch(function (error) {
                        progressStepFail(nestSettings['byKey'][key].container_name + ' project create failed [' + error + ']', progressMarker);
                        deferred.reject(nestSettings);
                        return;
                    });                
                })
                .catch(function (error) {
                    progressStepFail(error, progressMarker);
                    deferred.resolve(nestSettings);
                });        
        })
        .catch(function (error) {
            progressStepFail('Attach failed [' + error + ']', progressMarker);
            deferred.reject(nestSettings);
            return;
        });

    return deferred;    
}

/**
 * up the scaffold nesst
 */
function scaffoldService(nestSettings, key, dockerMachineIP, progressMarker, rootFolder) : any 
{
    let deferred = Q.defer();

    nestSettings['byKey'][key].environment['NEST_DOCKER_MACHINE_IP'] = dockerMachineIP;
    progressStep("Discovering " + nestSettings['byKey'][key].container_name + " ports, this may take a minute or two ...", progressMarker);
    
    var viewPort = '';
    if (key === 'db-mariadb')
    {
        viewPort = ' 80';
    }
    else if (key === 'queue-rabbitmq')
    {
        viewPort = ' 15672';
    }

    exec('docker port ' + nestSettings['byKey'][key].container_name + viewPort, (error, stdout, stderr) => {

        if (error !== null) {
            progressStep("Ensure docker is installed and is accessible from this environment", progressMarker);                               
            progressStepFail(stderr, progressMarker);
            deferred.reject(nestSettings);
            return;
        }

        if (stdout !== null)
        {
            progressStep(stdout, progressMarker);            
        }
        
        progressStep("Port found ... saving info on " + nestSettings['byKey'][key].container_name, progressMarker);
        var arr = stdout.trim().split(":");
        nestSettings['byKey'][key].environment['NEST_SERVICE_VIEW_PORT'] = arr[1];
        // done!
        deferred.resolve(nestSettings);
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

    var progressMarker = progressStart("scaffold");
    let deferred = Q.defer();

    var nestSettings = getNestSettings(progressMarker);
    if (!nestSettings || nestSettings['names'].length === 0)
    {
        progressStepFail('No nest projects found', progressMarker);
        deferred.reject();        
        return;
    }

    exec('docker-machine ip', 
        (error, stdout, stderr) => {

        var dockerMachineIP = "127.0.0.1";
        
        if (error !== null) 
        {
            progressStep("docker-machine ip did not resolve docker ip.. using localhost", progressMarker);            
        }
        else
        {
            dockerMachineIP = stdout.trim();            
        }
    
        progressStep("Docker IP is ... " + dockerMachineIP, progressMarker);
        progressStep("Composing docker containers", progressMarker);
        progressStep("The docker images will be downloaded and built", progressMarker);        
        progressStep("This may take a while, please wait ...", progressMarker);

        var theDevkit = devkit(rootFolder); 

        exec('docker-compose --file '+ theDevkit +' down', { 'cwd' : rootFolder }, 
            (error, stdout, stderr) => {
            
            if (error !== null) {
                progressStep("Ensure docker is installed and is accessible from this environment", progressMarker);                
                progressStepFail(stderr, progressMarker);
                deferred.reject();                
                return;
            }
                    
            if (stdout !== null)
            {
                progressStep(stdout, progressMarker);            
            }                
                
            exec('docker-compose --file '+ theDevkit +' up -d', { 'cwd' : rootFolder }, 
                (error, stdout, stderr) => {
                                                    
                if (error !== null) {
                    progressStep("Ensure docker is installed and is accessible from this environment", progressMarker);                    
                    progressStepFail(stderr, progressMarker);
                    deferred.reject();                
                    return;
                }

                if (stdout !== null)
                {
                    progressStep(stdout, progressMarker);            
                }                
                
                var services = [];

                Object.keys(nestSettings['byKey']).forEach(function(key, index) {
                    if (nestSettings['byKey'][key].environment['NEST_TAG'])
                    {
                        progressStep("Downloading the source ...", progressMarker);
                        services.push(scaffoldNest(nestSettings, key, dockerMachineIP, progressMarker, rootFolder).promise);                        
                    } 
                    else if (nestSettings['byKey'][key].environment['NEST_APP_SERVICE'])
                    {
                        progressStep("Discovering services ...", progressMarker);
                        services.push(scaffoldService(nestSettings, key, dockerMachineIP, progressMarker, rootFolder).promise);                        
                    }                    
                });

                Q.all(services).done(function (values) {
                    progressStep("Setting shared area upstream.", progressMarker);

                    var gitInit = `git config --local core.sshCommand "ssh -F ${rootFolder}/.ssh_config" && git config --local core.fileMode false`.replace(/\\/g,"/");
                    var sharedFolder = rootFolder + "/source/shared";

                    exec(gitInit, { 'cwd' : sharedFolder}, 
                        (error, stdout, stderr) => {

                        if (stdout !== null)
                        {
                            progressStep(stdout, progressMarker);            
                        } 
                                        
                        if (error !== null) {
                            progressStepFail(stderr, progressMarker);
                            deferred.reject(nestSettings);
                            return;
                        }

                        setNestSettings(progressMarker, nestSettings);
                        progressEnd(progressMarker);
                        deferred.resolve(nestSettings);                        
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

    var help = `
        -------------------------------------
                    Nest Commands            
        -------------------------------------
        Nest Select, to Select a project.    
        Nest Data Up, to upload data to production.
        Nest Data Down, to download data into test.
        Nest View Data, to view test data.
        Nest View Queue, to view test queue.         
        Nest Restore, to restore the project.
        Nest Build, to build the project.
        Nest Clean, to clean the output.
        Nest Clear, to remove output folders.
        Nest Kill, to kill the in-container run-time.        
        Nest Remap, to recapture ports.
        Nest Pull, to pull from production.
        Nest Push, to push in production.
        Nest Scaffold, to build assets when new or updated.
        Use git push to archive the code.     
    `;

    notifier.outputChannel.append(help);
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
    console.log('Congratulations, your extension "Nester Develop" is now active!');

    try {
        createNotifiers();

        var workspace = vscode.workspace;
        var config = workspace.getConfiguration('omnisharp');
        config.update('path', 'Nope');
        
        let dataUpDisposable = vscode.commands.registerCommand('extension.dataup', () => { return showProgress(dataUp); });
        let dataDownDisposable = vscode.commands.registerCommand('extension.datadown', () => { return showProgress(dataDown); });
        let viewdataDisposable = vscode.commands.registerCommand('extension.viewdata', () => viewData());
        let viewqueueDisposable = vscode.commands.registerCommand('extension.viewqueue', () => viewQueue());              
        let pullDisposable = vscode.commands.registerCommand('extension.pull', () => { return showProgress(pull) });        
        let pushDisposable = vscode.commands.registerCommand('extension.push', () => { return showProgress(push) });
        let selectDisposable = vscode.commands.registerCommand('extension.select', () => select( ) );
        let cleanDisposable = vscode.commands.registerCommand('extension.clean', () => { return showProgress(clean) });      
        let clearDisposable = vscode.commands.registerCommand('extension.clear', () => { return showProgress(clear) });              
        let resetDisposable = vscode.commands.registerCommand('extension.reset', () => { return showProgress(reset) });
        let killDisposable = vscode.commands.registerCommand('extension.kill', () => { return showProgress(kill) });        
        let buildDisposable = vscode.commands.registerCommand('extension.build', () => { return showProgress(build) });
        let helpDisposable = vscode.commands.registerCommand('extension.help', () => help( ) );        
        let restoreDisposable = vscode.commands.registerCommand('extension.restore', () => { return showProgress(restore) });        
        let scaffoldDisposable = vscode.commands.registerCommand('extension.scaffold', () =>
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
        context.subscriptions.push(pullDisposable);
        context.subscriptions.push(pushDisposable);
        context.subscriptions.push(selectDisposable);
        context.subscriptions.push(cleanDisposable);
        context.subscriptions.push(clearDisposable);
        context.subscriptions.push(resetDisposable);
        context.subscriptions.push(buildDisposable);
        context.subscriptions.push(killDisposable);           
        context.subscriptions.push(restoreDisposable);                  
        context.subscriptions.push(scaffoldDisposable);
        context.subscriptions.push(helpDisposable);

    } catch( exception ) {
        showError("Sorry, something went wrong with Nest services", exception);
    }
}

// this method is called when your extension is deactivated
export function deactivate() {
    destroyNotifiers();    
}
