'use strict';
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import path = require('path');
import {window, commands, Disposable, ExtensionContext, StatusBarAlignment, StatusBarItem, TextDocument} from 'vscode';

var spawn = require('child-process-promise').spawn;
var exec = require('child-process-promise').exec;
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
 * up the build
 */
function buildNestProject(nestProject, statusBarItem) : any {    
    let deferred = Q.defer();

    exec('docker exec ' + nestProject.container_name + '  dotnet restore ' + 
        nestProject.environment['NEST_FOLDER_SOURCE'], 
        (error, stdout, stderr) => {

        if (error !== null) {
            progressStepFail(stderr, statusBarItem);
            deferred.reject(nestProject);
            return;
        }

        console.log(stdout);
        console.log(stderr);    
        progressStep(nestProject.container_name + " build step 1/4 OK.", statusBarItem);

        exec('docker exec ' + nestProject.container_name + ' dotnet publish ' + 
            nestProject.environment['NEST_FOLDER_SOURCE'] + ' -c Debug -o ' +
            nestProject.environment['NEST_FOLDER_PUBLISH'], 
            (error, stdout, stderr) => {

            if (error !== null) {
                progressStepFail(stderr, statusBarItem);
                deferred.reject(nestProject);                    
                return;
            }

            console.log(stdout);
            console.log(stderr);
            progressStep(nestProject.container_name + " build step 2/4 OK.", statusBarItem);
            const rootFolder = nestProject.environment['NEST_FOLDER_ROOT'];
            const nestTag = nestProject.environment['NEST_TAG'];
            const nestFolder = rootFolder + '/source/' + nestTag;

            exec('dotnet restore', 
                { 'cwd' : nestFolder }, 
                (error, stdout, stderr) => {

                if (error !== null) {
                    progressStepFail(stderr, statusBarItem);
                    deferred.reject(nestProject);
                    return;
                }

                console.log(stdout);
                console.log(stderr);
                progressStep(nestProject.container_name + " build step 3/4 OK.", statusBarItem);
                
                exec('dotnet build -c Debug', 
                    { 'cwd' : nestFolder }, 
                    (error, stdout, stderr) => {

                    if (error !== null) {
                        progressStepFail(stderr, statusBarItem);
                        deferred.reject(nestProject);                    
                        return;
                    }

                    console.log(stdout);
                    console.log(stderr);                    
                    progressStep(nestProject.container_name + " build complete.", statusBarItem);
                    progressEnd(statusBarItem);
                    deferred.resolve(nestProject);                
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
    progressStep("Attaching " + nestProject.container_name + ", this may take a minute or two ...", statusBarItem);
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

        const nestContainer = '/var/app' + nestFolder;

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

        /* 
            Add this to see logs
                "logging": {
                    "engineLogging": true
                },
        */
        var launchConfig = {
            version: '0.2.0',
            configurations: [
                {
                    "name": "Attach Nest",
                    "type": "coreclr",
                    "request": "launch",
                    "cwd": "/var/app/source/n1/",
                    "program": "/var/app/source/n1/bin/Debug/netcoreapp2.0/n1.dll",	
                    "sourceFileMap": {
                        "/var/app/source/n1" : "${workspaceRoot}"
                    },	
                    "env": {
                        "ASPNETCORE_ENVIRONMENT": "Development"
                    },							
                    "pipeTransport": {
                        "debuggerPath": "/vsdbg/vsdbg",
                        "pipeProgram": "ssh",
                        "pipeCwd": "${workspaceRoot}",
                        "pipeArgs": [
                            "-i",
                            "c:\\Users\\rajitha\\Documents\\inkton\\testbed\\Sample8/.contact_key",
                            "-o",
                            "UserKnownHostsFile=/dev/null",
                            "-o",
                            "StrictHostKeyChecking=no",
                            "root@192.168.99.100",
                            "-p",
                            "32811"
                        ],
                        "quoteArgs": true
                    }	
                }   
            ]
        };

        launchConfig['configurations'][0]['cwd'] = nestContainer;
        launchConfig['configurations'][0]['program'] = nestProject.environment['NEST_FOLDER_PUBLISH'];

        var parser = new xml2js.Parser();
        fs.readFile(nestHost + '/' + nestTag + '.csproj', function(err, data) {
            parser.parseString(data, function (error, result) {

                progressStep("Emitting " + nestHost + '/.vscode/launch.json', statusBarItem);        
                
                launchConfig['configurations'][0]['program'] += '/' + nestTag + '.dll';
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
                const rootFolder = nestProject.environment['NEST_FOLDER_ROOT'];

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
        progressStep("Deploy complete.", statusBarItem);
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

        exec('docker exec ' + nestProject.container_name + ' rm -rf ' + 
            nestProject.environment['NEST_FOLDER_PUBLISH'],
            (error, stdout, stderr) => {

            if (error !== null) {
                progressStepFail('Clean failed', statusBarItem);
                deferred.reject(nestProject);
                return;                
            }

            console.log(stdout);
            console.log(stderr);
            progressStep("Clean complete.", statusBarItem);
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
    var statusBarItem = progressStart("Remapping ports ...");
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

        var buildsComplete = 0;
        Object.keys(nestServices['byKey']).forEach(function(key, index) {
            if (nestServices['byKey'][key].environment['NEST_TAG'])
            {
                nestServices['byKey'][key].environment['NEST_DOCKER_MACHINE_IP'] = dockerMachineIP;                
                progressStep("Remapping " + nestServices['byKey'][key].container_name, statusBarItem);

                exec('docker-compose up -d', { 'cwd' : nestServices['byKey'][key].environment['NEST_FOLDER_ROOT'] }, 
                    (error, stdout, stderr) => {
                    
                    if (error !== null) {                        
                        progressStepFail(stderr, statusBarItem);
                        deferred.reject(nestServices);                
                        return;
                    }

                    createNestProject(nestServices['byKey'][key], statusBarItem)
                        .then(function (result) {
                            ++buildsComplete;
                            if (buildsComplete >= nestServices['names'].length)
                            {
                                deferred.resolve(nestServices);
                                progressStep('The ports have been remapped.', statusBarItem);                                            
                                progressEnd(statusBarItem);                                                                            
                            }
                        })
                        .catch(function (error) {
                            progressStepFail(nestServices['byKey'][key].container_name + ' project remap failed', statusBarItem);
                            deferred.reject(nestServices);
                            return;
                        });
                });                
            }
        });
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

    var statusBarItem = progressStart("Building ...");
    return buildNestProject(nestProject, statusBarItem);
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

        const workspace = vscode.workspace;
        var dockerMachineIP = stdout.trim();

        progressStep("Docker IP is ... " + dockerMachineIP, statusBarItem);
        progressStep("Composing docker containers", statusBarItem);
        progressStep("The docker images will be downloaded and built", statusBarItem);        
        progressStep("This may take a while, please wait ...", statusBarItem);

        exec('docker-compose down', { 'cwd' : workspace.rootPath }, 
            (error, stdout, stderr) => {
            
            exec('docker-compose up -d', { 'cwd' : workspace.rootPath }, 
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

                        exec('docker exec ' + nestServices['byKey'][key].container_name + ' nester app attach')
                            .then(function (result) {
                                progressStep("Attach ok ..., creating project " + nestServices['byKey'][key].container_name, statusBarItem);

                                createNestProject(nestServices['byKey'][key], statusBarItem)
                                    .then(function (result) {

                                    progressStep("Project " + nestServices['byKey'][key].container_name + " created, now building ...", statusBarItem); 
                            
                                    buildNestProject(nestServices['byKey'][key], statusBarItem)
                                        .then(function (value) {
                                            ++buildsComplete;
                                            if (buildsComplete >= nestServices['names'].length)
                                            {
                                                deferred.resolve(nestServices);
                                                progressStep('-------------------------------------', statusBarItem);
                                                progressStep('      The scaffold is in place', statusBarItem);
                                                progressStep('-------------------------------------', statusBarItem);
                                                progressStep('Nest + Select, to Select a project.', statusBarItem);                                            
                                                progressStep('Nest + Build, to build the project.', statusBarItem);
                                                progressStep('Nest + Clean, to clean the output.', statusBarItem);
                                                progressStep('Nest + Remap, to recapture ports.', statusBarItem);                                            
                                                progressStep('Nest + Deploy, to deploy in production.', statusBarItem);
                                                progressStep('Use git push to archive the code.', statusBarItem);                                            
                                                progressEnd(statusBarItem);                                                                            
                                            }
                                        })
                                        .catch(function (error) {
                                            progressStepFail(nestServices['byKey'][key].container_name + ' project build failed', statusBarItem);
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
        let scaffoldDisposable = vscode.commands.registerCommand('extension.inkton-nest.scaffold', () =>
            exec('git --version')
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
        context.subscriptions.push(scaffoldDisposable);
    } catch( exception ) {
        showError("Sorry, something went wrong with Nest services", exception);
    }
}

// this method is called when your extension is deactivated
export function deactivate() {
    
}