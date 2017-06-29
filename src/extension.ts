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
function getNestServices(statusBarItem) : any {
    const rootFolder = getRootFolder();

    if (rootFolder !== null)
    {        
        if (pathExists.sync(rootFolder + '/docker-compose.yml'))
        {
            progressStep("Found services ... ", statusBarItem);
    
            var nest = null;
            var nestServices = {};

            nestServices['names'] = [];
            nestServices['byKey'] = {};
            nestServices['app'] = null;
            nestServices['workers'] = [];
                            
            nest = yaml.load(rootFolder + '/docker-compose.yml');
            Object.keys( nest.services).forEach(function(key, index) {
                switch (nest.services[key].environment['NEST_PLATFORM_TAG'])
                {
                    case 'unihandler':
                    case 'bihandler':
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
 * up the restore
 */

function restoreNestProject(nestProject, statusBarItem) : any {    
    let deferred = Q.defer();
    const rootFolder = nestProject.environment['NEST_FOLDER_ROOT'];
    const nestTag = nestProject.environment['NEST_TAG'];
    const nestFolder = rootFolder + '/source/' + nestTag;
    
    progressStep("Restoring " + nestProject.container_name + " ...", statusBarItem);

    exec('dotnet restore --packages ' + rootFolder + '/packages', 
        { 'cwd' : nestFolder }, 
        (error, stdout, stderr) => {

        if (error !== null) {
            progressStepFail(stdout, statusBarItem);
            deferred.reject(nestProject);
            return;
        }

        console.log(stdout);
        console.log(stderr);
        progressStep(nestProject.container_name + " restore step 1/2 OK.", statusBarItem);

        exec('docker exec ' + nestProject.container_name + ' nester app test_restore ',
            (error, stdout, stderr) => {

            if (error !== null) {
                progressStepFail(stderr, statusBarItem);
                deferred.reject(nestProject);
                return;
            }

            progressStep(nestProject.container_name + " restore step 1/2 OK.", statusBarItem);

            progressEnd(statusBarItem);
            deferred.resolve(nestProject);
        });
    });
            
   return deferred.promise;
}


/**
 * up the build
 */

function buildNestProject(nestProject, statusBarItem) : any {    
    let deferred = Q.defer();
    const rootFolder = nestProject.environment['NEST_FOLDER_ROOT'];
    const nestTag = nestProject.environment['NEST_TAG'];
    const nestFolder = rootFolder + '/source/' + nestTag;

    progressStep("Building " + nestProject.container_name + " ...", statusBarItem);

    exec('dotnet build -c Debug', 
        { 'cwd' : nestFolder }, 
        (error, stdout, stderr) => {

        if (error !== null) {
            progressStepFail(stdout, statusBarItem);
            deferred.reject(nestProject);                    
            return;
        }

        console.log(stdout);
        console.log(stderr);                    

        progressStep(nestProject.container_name + " build step 1/2 OK.", statusBarItem);

        exec('docker exec ' + nestProject.container_name + ' nester app test_build ', 
            (error, stdout, stderr) => {

            if (error !== null) {
                progressStepFail(stderr, statusBarItem);
                deferred.reject(nestProject);                    
                return;
            }

            progressStep(nestProject.container_name + " build complete.", statusBarItem);
            progressEnd(statusBarItem);
            deferred.resolve(nestProject);
        });
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
        const nestFolder = '/source/' + nestTag;
        const nestHost = nestProject.environment['NEST_FOLDER_ROOT'] + nestFolder;

        if (!fs.existsSync(nestHost))
        {
            progressStepFail('Download failed.', statusBarItem);
            deferred.reject(nestProject);
            return;                
        }

        fs.writeFile(nestHost + '/nest.json', 
            JSON.stringify(nestProject), 'utf-8', function(error) {

            if (error !== null) {
                progressStepFail('Docker exec failed', statusBarItem);
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

        taskConfig.tasks[0].args[0] = "${workspaceRoot}/" + nestTag + ".csproj";
        
        fs.writeFile(nestHost + '/.vscode/tasks.json', 
            JSON.stringify(taskConfig, null, '\t'), 'utf-8', function(error) {

            progressStep("Emitting " + nestHost + '/.vscode/tasks.json', statusBarItem);        

            if (error !== null) {
                progressStepFail('Failed to create ' + nestHost + '/.vscode/tasks.json', statusBarItem);
                deferred.reject(nestProject);                
                return;
            }
        });

        const rootFolder = nestProject.environment['NEST_FOLDER_ROOT'];
        const nestShadowApp = '/var/app_shadow' + nestFolder;

        launchConfig['configurations'][0]['cwd'] = nestShadowApp;
        launchConfig['configurations'][0]['program'] = nestShadowApp;     
        launchConfig['configurations'][0].sourceFileMap = {};
        launchConfig['configurations'][0].sourceFileMap[nestShadowApp] = "${workspaceRoot}" ;
        launchConfig['configurations'][0].sourceFileMap['/var/app_shadow/source/shared'] = rootFolder + '/source/shared';

        var parser = new xml2js.Parser();
        fs.readFile(nestHost + '/' + nestTag + '.csproj', function(err, data) {
            parser.parseString(data, function (error, result) {

                progressStep("Emitting " + nestHost + '/.vscode/launch.json', statusBarItem);        
                                
                launchConfig['configurations'][0]['program'] +=  '/bin/Debug/' + 
                    result.Project.PropertyGroup[0].TargetFramework[0] + '/' + nestTag + '.dll';                
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
                    
                    progressStep("Project ssh_config created.", statusBarItem);        

                    var gitInit = `git config --local core.sshCommand "ssh -F ${rootFolder}/.ssh_config" && `.replace(/\\/g,"/");
                    gitInit += " git fetch &&";
                    gitInit += ` git branch --set-upstream-to=origin/${nestTag}-master ${nestTag}-master`;

                    exec(gitInit, { 'cwd' : nestHost}, 
                        (error, stdout, stderr) => {

                        if (error !== null) {
                            progressStepFail('Failed to init git', statusBarItem);
                            deferred.reject(nestProject);
                            return;
                        }

                        console.log(stdout);
                        console.log(stderr);
                        progressStep(`Project ${nestTag} tracks remote branch ${nestTag}-master`, statusBarItem);

                        fs.writeFile(nestHost + '/.vscode/launch.json', 
                            JSON.stringify(launchConfig, null, '\t'), 'utf-8', function(error) {
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
 * up the deploy
 */
function deploy() : any {

    const nestProject = getNestProject();
    if (nestProject === null)
        return false;

    var statusBarItem = progressStart("Deploying ...");
    let deferred = Q.defer();
    const workspace = vscode.workspace;

    exec('docker exec ' + nestProject.container_name + ' nester deployment publish ', 
        (error, stdout, stderr) => {

        if (error !== null) {
            progressStepFail('Deployment failed', statusBarItem);
            deferred.reject(nestProject);
            return;
        }

        console.log(stdout);
        console.log(stderr);

        progressStep('-------------------------------------', statusBarItem);
        progressStep('   The project hss been deployed     ', statusBarItem);
        progressStep('-------------------------------------', statusBarItem);
        progressStep('Nest + Help to list avaiable Nest commands.', statusBarItem);        
        progressEnd(statusBarItem);

        deferred.resolve(nestProject); 
    });
            
   return deferred.promise;
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

    vscode.window.showQuickPick(nestServices['names'])
        .then(selected => {
            if (selected)
            {
                var proj = nestServices['byKey'][selected];
                if (proj) {
                    const rootFolder = getRootFolder();                    
                    let uri = vscode.Uri.parse('file:///' + rootFolder + '/source/' + proj.environment['NEST_TAG']);
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

function clean() : any {
    const nestProject = getNestProject();
    if (nestProject === null)
        return false;

    var statusBarItem = progressStart("Cleaning ...");
    let deferred = Q.defer();
    const workspace = vscode.workspace;

    exec('dotnet clean', { 'cwd' : workspace.rootPath }, 
        (error, stdout, stderr) => {

        if (error !== null) {
            progressStepFail('Clean failed', statusBarItem);
            deferred.reject(nestProject);
            return;
        }

        console.log(stdout);
        console.log(stderr);
        statusBarItem.text = "Attaching the container app ..."

        exec('rm -rf {obj,bin} ', { 'cwd' : workspace.rootPath },
            (error, stdout, stderr) => {

            if (error !== null) {
                progressStepFail('Clean failed', statusBarItem);
                deferred.reject(nestProject);
                return;                
            }

            console.log(stdout);
            console.log(stderr);
            progressStep('-------------------------------------', statusBarItem);
            progressStep('          The project is clean       ', statusBarItem);
            progressStep('-------------------------------------', statusBarItem);
            progressStep('Nest + Help to list avaiable Nest commands.', statusBarItem);
            progressEnd(statusBarItem);                                                                                                                        
            deferred.resolve(nestProject);            
        });
    });

    return deferred.promise;
}

/**
 * up the remap
 */
function remap() : any {
    const nestProject = getNestProject();
    if (nestProject === null)
        return false;

    let deferred = Q.defer();
    var statusBarItem = progressStart("Remapping ...");

    createNestProject(nestProject, statusBarItem)
        .then(function (value) {
            progressStep('-------------------------------------', statusBarItem);
            progressStep('    The project has been remapped    ', statusBarItem);
            progressStep('-------------------------------------', statusBarItem);
            progressStep('Nest + Help to list avaiable Nest commands.', statusBarItem);                                                
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
function restore() : any { 
    const nestProject = getNestProject();
    if (nestProject === null)
        return false;

    let deferred = Q.defer();
    var statusBarItem = progressStart("Restoring ...");

    restoreNestProject(nestProject, statusBarItem)
        .then(function (value) {
            progressStep('-------------------------------------', statusBarItem);
            progressStep('    The project has been restored    ', statusBarItem);
            progressStep('-------------------------------------', statusBarItem);
            progressStep('Nest + Help to list avaiable Nest commands.', statusBarItem);                                                
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

    buildNestProject(nestProject, statusBarItem)
        .then(function (value) {
            progressStep('-------------------------------------', statusBarItem);
            progressStep('      The project has been built     ', statusBarItem);
            progressStep('-------------------------------------', statusBarItem);
            progressStep('Nest + Help to list avaiable Nest commands.', statusBarItem);                                                
            progressEnd(statusBarItem);
            deferred.resolve(nestProject);            
        })
        .catch(function (error) {
            deferred.reject();                            
        });

   return deferred.promise;        
}

/**
 * up the scaffold
 */
function scaffold() : any {    
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

        const rootFolder = getRootFolder();
        var dockerMachineIP = stdout.trim();

        progressStep("Docker IP is ... " + dockerMachineIP, statusBarItem);
        progressStep("Composing docker containers", statusBarItem);
        progressStep("The docker images will be downloaded and built", statusBarItem);        
        progressStep("This may take a while, please wait ...", statusBarItem);

        exec('docker-compose down', { 'cwd' : rootFolder }, 
            (error, stdout, stderr) => {
            
            exec('docker-compose up -d', { 'cwd' : rootFolder }, 
                (error, stdout, stderr) => {
                
                if (error !== null) {
                    progressStepFail(stderr, statusBarItem);
                    deferred.reject(nestServices);                
                    return;
                }

                console.log(stdout);
                console.log(stderr);
                progressStep("Downloading the source ...", statusBarItem);
                
                var buildsComplete = 0;

                Object.keys(nestServices['byKey']).forEach(function(key, index) {
                    if (nestServices['byKey'][key].environment['NEST_TAG'])
                    {
                        nestServices['byKey'][key].environment['NEST_DOCKER_MACHINE_IP'] = dockerMachineIP;
                        progressStep("Attaching " + nestServices['byKey'][key].container_name + ", this may take a minute or two ...", statusBarItem);

                        execPromise('docker exec ' + nestServices['byKey'][key].container_name + ' nester app attach')
                            .then(function (result) {
                                progressStep("Attach ok ..., creating project " + nestServices['byKey'][key].container_name, statusBarItem);

                                createNestProject(nestServices['byKey'][key], statusBarItem)
                                    .then(function (result) {
                                    
                                    progressStep("Project " + nestServices['byKey'][key].container_name + " created, now restoring ...", statusBarItem); 

                                        restoreNestProject(nestServices['byKey'][key], statusBarItem)
                                            .then(function (value) {
                                                ++buildsComplete;
                                                if (buildsComplete >= nestServices['names'].length)
                                                {
                                                    buildsComplete = 0;

                                                    progressStep("Project " + nestServices['byKey'][key].container_name + " created, now building ...", statusBarItem); 
                                            
                                                    buildNestProject(nestServices['byKey'][key], statusBarItem)
                                                        .then(function (value) {
                                                            ++buildsComplete;
                                                            if (buildsComplete >= nestServices['names'].length)
                                                            {
                                                                progressStep("Setting shared area upstream.", statusBarItem);        

                                                                var gitInit = `git config --local core.sshCommand "ssh -F ${rootFolder}/.ssh_config" && `.replace(/\\/g,"/");
                                                                gitInit += " git fetch &&";
                                                                gitInit += ` git branch --set-upstream-to=origin/shared-master shared-master`;
                                                                var sharedFolder = rootFolder + "/source/shared";

                                                                exec(gitInit, { 'cwd' : sharedFolder}, 
                                                                    (error, stdout, stderr) => {

                                                                    if (error !== null) {
                                                                        progressStepFail('Failed to init git', statusBarItem);
                                                                        deferred.reject(nestServices);
                                                                        return;
                                                                    }

                                                                    console.log(stdout);
                                                                    console.log(stderr);

                                                                    deferred.resolve(nestServices);
                                                                    progressStep('-------------------------------------', statusBarItem);
                                                                    progressStep('      The scaffold is in place       ', statusBarItem);
                                                                    progressStep('-------------------------------------', statusBarItem);
                                                                    progressStep('Nest + Help to list avaiable Nest commands.', statusBarItem);                                                
                                                                    progressEnd(statusBarItem);                                                                    
                                                                });
                                                            }
                                                        })
                                                        .catch(function (error) {
                                                            progressStepFail(nestServices['byKey'][key].container_name + ' project build failed', statusBarItem);
                                                            deferred.reject(nestServices);
                                                        });
                                                }
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
                    }
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
    console.log('Nest + Select, to Select a project.');                                                
    console.log('Nest + Restore, to restore the project.');                                                
    console.log('Nest + Build, to build the project.');
    console.log('Nest + Clean, to clean the output.');
    console.log('Nest + Remap, to recapture ports.');                                            
    console.log('Nest + Deploy, to deploy in production.');
    console.log('Nest + Scaffold, to build assets when new or updated.');            
    console.log('Use git push to archive the code.');                                            
}


// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

    // Use the console to output diagnostic information (console.log) and errors (console.error)
    // This line of code will only be executed once when your extension is activated
    console.log('Congratulations, your extension "inkton-nest" is now active!');

    try {
        let deployDisposable = vscode.commands.registerCommand('extension.inkton-nest.deploy', () => deploy( ) );
        let selectDisposable = vscode.commands.registerCommand('extension.inkton-nest.select', () => select( ) );
        let cleanDisposable = vscode.commands.registerCommand('extension.inkton-nest.clean', () => clean() );        
        let remapDisposable = vscode.commands.registerCommand('extension.inkton-nest.remap', () => remap() );        
        let buildDisposable = vscode.commands.registerCommand('extension.inkton-nest.build', () => build( ) );
        let helpDisposable = vscode.commands.registerCommand('extension.inkton-nest.help', () => help( ) );        
        let restoreDisposable = vscode.commands.registerCommand('extension.inkton-nest.restore', () => restore( ) );        
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

                    scaffold( );
                })
                .catch(function (exception) {
                    showError("Failed to check if Git is installed");
                })   
        );

        context.subscriptions.push(deployDisposable);
        context.subscriptions.push(selectDisposable);
        context.subscriptions.push(cleanDisposable);
        context.subscriptions.push(remapDisposable);
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