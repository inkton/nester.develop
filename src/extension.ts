'use strict';
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as os from 'os';
import * as https from 'https';
import {window, commands, Disposable, ExtensionContext, StatusBarAlignment, StatusBarItem, TextDocument} from 'vscode';

var execPromise = require('child-process-promise').exec,
    exec = require('child_process').exec,
    spawn = require('child_process').spawn,
    yaml = require('yamljs'),
    fs = require("fs"),
    hidefile = require("hidefile"),
    xml2js = require('xml2js'),
    Q = require('q'),
    accents = require('remove-accents'),
    path = require('path'),
    streamZip = require('node-stream-zip'),
    encodeUrl = require('encodeurl'),
    git = require('simple-git');

class DeferredResult {
    subject: any;
    success : boolean;
    constructor(subject: any) {
        this.subject = subject;
        this.success = false;
    }
}

var notifier: {
    subject : string,
    statusBar : any;
    outputChannel : any;
};

function createNotifiers() : void {
    var statusBarItem = window.createStatusBarItem(StatusBarAlignment.Left);
    statusBarItem.show();

    var myOutputChannel = vscode.window.createOutputChannel('nester.develop');
    myOutputChannel.show();

    notifier = { subject : "", statusBar: statusBarItem,  outputChannel: myOutputChannel };
}

function deleteFolderRecursive(deletePath)  : void {
    if (fs.existsSync(deletePath)) {
      fs.readdirSync(deletePath).forEach(function(file, index){
        var curPath = path.resolve(deletePath, file);
        if (fs.lstatSync(curPath).isDirectory()) { // recurse
          deleteFolderRecursive(curPath);
        } else { // delete file
          fs.unlinkSync(curPath);
        }
      });
      fs.rmdirSync(deletePath);
    }
}

function destroyNotifiers() : void {
    notifier.statusBar.dispose();
    notifier.outputChannel.dispose();
}

function showError(message, exception = null) : void {
    var errorMessage = message;
    if (exception !== null)
    {
        errorMessage += ' [' + exception + ']';
    }
    console.error(errorMessage);
    vscode.window.showErrorMessage(errorMessage);
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
    var output = message + "\n";
    notifier.statusBar.text = output;
    notifier.outputChannel.append(output);
    console.log(message);
}

function progressStepFail(message, progressMarker) : void {
    var output = "<-- " + notifier.subject + " failed";
    if (typeof message === 'string' || message instanceof String)
    {
        output += "\n[ " + message + " ]";
    }
    progressMarker.statusBar.text = output;
    progressMarker.outputChannel.appendLine(output);
    console.log(output);
}

function progressEnd(progressMarker) : void {
    var output = "<-- " + notifier.subject + " ended";
    notifier.outputChannel.appendLine(output);
    notifier.outputChannel.appendLine("'Nest Help' lists avaiable Nest commands");
}

function isNestProject(folder) : Boolean {
    try
    {
        return fs.existsSync(path.resolve(folder, 'nest.json'));
    } catch (e) {
        return false;
    }
}

function devkit(folder) : string {
    var files = fs.readdirSync(folder)
        .filter(fn => fn.endsWith('.devkit'));

    if (files.length !== 0)
    {
        return path.resolve(folder, files[0]);
    }

    return null;
}

function getRootFolder(showAlert = true) : string {
    const workspace = vscode.workspace;

    if (workspace && workspace.rootPath !== null)
    {
        if (devkit(workspace.rootPath) !== null)
        {
            return workspace.rootPath;
        }
        else if (devkit(path.resolve(workspace.rootPath, '..', '..')) !== null )
        {
            return path.resolve(workspace.rootPath, '..', '..');
        }
        else if (isNestProject(workspace.rootPath))
        {
            var nest = JSON.parse(fs.readFileSync(path.resolve(workspace.rootPath, 'nest.json')));
            return nest.environment['NEST_FOLDER_ROOT'];
        }
    }

    if (showAlert)
    {
        showError('Please open a folder with a valid Nest devkit first');
    }

    return null;
}

function getSourceFolder(showAlert = true) : string {
    const rootFolder = getRootFolder(showAlert);
    if (!rootFolder)
    {
        return;
    }   
    return path.resolve(rootFolder, 'source');
}

function getSharedFolder(showAlert = true) : string {
    var thisSharedPath = getSourceFolder(showAlert);
    return path.resolve(thisSharedPath, 'shared');
}

function getGitFolderBranches(folder) : any {
    let deferred = Q.defer();
    const sharedFolder = getSharedFolder(false);
    const branchPrefix = "remotes/origin/" + folder.trim().toLowerCase() + "-";

    let branchPick = [];

    git(sharedFolder).branch(function (err, branchSummary) {
        Object.keys(branchSummary.all).forEach(function(branch, index) {

            if (branchSummary.all[branch].startsWith(branchPrefix))
            {
                branchPick.push(branchSummary.all[branch]);
            }
        });
        
        deferred.resolve(branchPick);        
    });  

    return deferred.promise;    
}

function ensureSshPermissions(rootFolder) : any {

    /* 
    the .contact_key is permissions keep 
    needs to be set such that it has adequate
    permissions.  
    */

    try
    {
        fs.chmodSync(path.resolve(rootFolder, '.contact_key'), 0o600);
    }
    catch(e)
    {
        // Throws "ENOENT: no such file or directory" error on windows.
        //progressStep("Chmod " + e, progressMarker);
    }
}

/**
 * get nest project
 */
function getNestProject(showAlert = true) : any {
    const workspace = vscode.workspace;
    if (workspace && workspace.rootPath !== null)
    {
        if (isNestProject(workspace.rootPath))
        {
            return JSON.parse(fs.readFileSync(path.resolve(workspace.rootPath, 'nest.json')));
        }
    }

    if (showAlert)
    {
        showError('Please open a folder with a valid Nest project (nest.json)  first');
    }

    return null;
}

function discoverNestSettings(progressMarker) : any 
{
    const rootFolder = getRootFolder();

    if (rootFolder !== null)
    {
        progressStep("Inspecting the devkit ... ", progressMarker);

        var nestSettings = {};

        nestSettings['names'] = [];
        nestSettings['byKey'] = {};
        nestSettings['app'] = null;
        nestSettings['services'] = {};
        nestSettings['workers'] = [];
        
        var devkitParsed = yaml.load(devkit(rootFolder));

        Object.keys(devkitParsed.services).forEach(function(key, index) {
            switch (devkitParsed.services[key].environment['NEST_PLATFORM_TAG'])
            {
                case 'mvc':
                case 'api': 
                    nestSettings['names'].push(key);
                    nestSettings['app'] = devkitParsed.services[key];
                    nestSettings['byKey'][key] = devkitParsed.services[key];
                    nestSettings['byKey'][key].environment['NEST_FOLDER_ROOT'] = rootFolder;
                    progressStep("Found a handler component " + key, progressMarker);
                    break;
                case 'worker':
                    nestSettings['names'].push(key);
                    nestSettings['workers'].push(devkitParsed.services[key]);
                    nestSettings['byKey'][key] = devkitParsed.services[key];
                    nestSettings['byKey'][key].environment['NEST_FOLDER_ROOT'] = rootFolder;
                    progressStep("Found a worker component " + key, progressMarker);
                    break;
            }

            switch (devkitParsed.services[key].environment['NEST_APP_SERVICE'])
            {
                case 'build':
                case 'storage':
                case 'batch':
                {
                    var theServiceType = devkitParsed.services[key].environment['NEST_APP_SERVICE'];
                    var theService = devkitParsed.services[key];

                    nestSettings['names'].push(key);
                    nestSettings['services'][theServiceType] = theService;
                    nestSettings['byKey'][key] = theService;
                    nestSettings['byKey'][key].environment['NEST_FOLDER_ROOT'] = rootFolder;
                    
                    progressStep("Found a service component " + key, progressMarker);
                    break;
                }
            }
        });
        
        return nestSettings;
    }
    else
    {
        progressStepFail('Failed to find a Devkit', progressMarker);
    }

    return null;
}

function saveNestSettings(rootFolder, nestSettings, progressMarker) : any 
{
    let deferred = Q.defer();

    fs.writeFile(path.resolve(rootFolder, 'settings.json'),
        JSON.stringify(nestSettings, null, 2), 'utf-8', function(error) {

        if (error !== null) {
            progressStepFail('settings.json save failed', progressMarker);
            deferred.reject(nestSettings);            
        }
        else
        {
            progressStep("Settings saved in " + rootFolder, progressMarker);
            deferred.resolve(nestSettings);
        }
    });

    return deferred.promise;
}

/**
 * is installed
 */
function isInstalled() : any {

    try
    {
        const rootFolder = getRootFolder();

        if (rootFolder !== null)
        {
            return fs.existsSync(
                path.resolve(rootFolder, 'settings.json'));
        }

    } catch (e) {
    }

    return false;
}

/**
 * get nest settings
 */
function getNestSettings() : any {

    try
    {
        const rootFolder = getRootFolder();

        if (rootFolder !== null)
        {
            var settingsFile = path.resolve(rootFolder, 'settings.json');
            return JSON.parse(fs.readFileSync(settingsFile));
        }
    
    } catch (e) {
        console.error(e);
    }

    return null;
}

/**
 * get nest service
 */
function getNestService(key, nestSettings = null) : any {

    if (nestSettings === null)
    {
        nestSettings = getNestSettings();
    }

    var service = null;

    Object.keys(nestSettings['services']).forEach(function(thisKey, index) {                    
        if (key === thisKey)
        {
            service = nestSettings['services'][key];
        }
    });

    return service;
}

/**
 * run nester command
 */

function runCommand(nestProject, command, progressMarker) : any {
    let deferred = Q.defer();

    progressStep("Working with " + nestProject.container_name + " ...", progressMarker);
    var parameters = ['exec', nestProject.container_name, 'nester', '-l', '/tmp/console_cmd'];
    parameters = parameters.concat(command);

    var child = spawn('docker', parameters);
    child.stdout.setEncoding('utf8');
      
    function processMessage(message)
    {
        if (message.indexOf("Permission denied") >= 0)
        {
            deferred.reject("Permission denied. The access keys have changed. Please request a DevKit with the new keys.");
        }
        else
        {
            progressStep(message, progressMarker);
        }
    }

    child.stdout.on('data', (data) => {
        processMessage(data.toString());
    });

    child.stderr.on('data', (data) => {
        processMessage(data.toString());
    });

    child.on('exit', function (code, signal) {
        if (code !== 0) {
            var msg = "Ensure docker is installed and is accessible from this environment\n" +
                    "Run <Nest Reset> command if docker containers are not running";
            deferred.reject(msg);
        }
        else
        {
            var commandDisplay = " ";
            var arrayLength = command.length;
            for (var i = 0; i < arrayLength; i++) {
                commandDisplay += command[i];
                commandDisplay += ' ';
            }

            progressStep(nestProject.container_name + commandDisplay + "ended.", progressMarker);
            deferred.resolve(nestProject);    
        }
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
            deferred.reject(error);
            return;
        }

        var arr = stdout.trim().split(":");
        nestProject.environment['NEST_SSH_PORT'] = arr[1];

        var nestTagCap = nestProject.environment['NEST_TAG_CAP'];
        var nestHost = path.resolve(nestProject.environment['NEST_FOLDER_ROOT'], 'source');
        nestHost = path.resolve(nestHost, nestTagCap);

        if (!fs.existsSync(nestHost))
        {
            progressStepFail('Download failed.', progressMarker);
            deferred.reject(nestProject);
            return;
        }

        fs.writeFile(path.resolve(nestHost, 'nest.json'),
            JSON.stringify(nestProject, null, 2), 'utf-8', function(error) {

            // this can carry on writing a file on its own

            if (error !== null) {
                progressStepFail('nest.json create failed', progressMarker);
                deferred.reject(nestProject);
                return;
            }
        });

        progressStep("Ensured a nest project file exist, creating assets ... ", progressMarker);
                
        if (!fs.existsSync(path.resolve(nestHost, '.vscode')))
        {
            fs.mkdirSync(path.resolve(nestHost, '.vscode'));
            progressStep("Created vscode assets folder ... ", progressMarker);
        }
        else
        {
            progressStep("The vscode folder exists " + path.resolve(nestHost, '.vscode'), progressMarker);
        }
        
        const rootFolder = nestProject.environment['NEST_FOLDER_ROOT'];
        var thisSharedPath = path.resolve(rootFolder, 'source');
        thisSharedPath = path.resolve(thisSharedPath, 'shared');

        // configure the nest debug
        const nestShadowApp = '/var/app/source/' + nestTagCap + '/src/';
        var hostSrcWorkspacePath = "${workspaceFolder}";

        if (os.platform() === 'win32') {
            hostSrcWorkspacePath += "\\src";
        }
        else
        {
            hostSrcWorkspacePath += "/src";
        }

        launchConfig['configurations'][0]['cwd'] = nestShadowApp;
        launchConfig['configurations'][0]['program'] = nestShadowApp;
        launchConfig['configurations'][0].sourceFileMap = {};
        launchConfig['configurations'][0].sourceFileMap[nestShadowApp] = hostSrcWorkspacePath;
        launchConfig['configurations'][0].sourceFileMap['/var/app/source/shared'] = thisSharedPath;        

        // configure the unit test debug
        const nestShadowUnitTest = '/var/app/source/' + nestTagCap + '/test/';
        var hostTestWorkspacePath = "${workspaceFolder}";

        if (os.platform() === 'win32') {
            hostTestWorkspacePath += "\\test";
        }
        else
        {
            hostTestWorkspacePath += "/test";
        }

        launchConfig['configurations'][1].sourceFileMap = {};
        launchConfig['configurations'][1].sourceFileMap[nestShadowApp] = hostSrcWorkspacePath;
        launchConfig['configurations'][1].sourceFileMap[nestShadowUnitTest] = hostTestWorkspacePath;
        launchConfig['configurations'][1].sourceFileMap['/var/app/source/shared'] = thisSharedPath;        

        var parser = new xml2js.Parser();
        
        var nestSource = path.resolve(nestHost, "src");

        fs.readFile(path.resolve(nestSource, nestTagCap + '.csproj'), function(error, data) {

            if (error !== null) {
                progressStepFail('failed to read file ' + path.resolve(nestSource, nestTagCap + '.csproj'), progressMarker);
                deferred.reject(nestProject);
                return;
            }

            parser.parseString(data, function (error, result) {

                if (error !== null) {
                    progressStepFail('Failed to parse string ' + data, progressMarker);
                    deferred.reject(nestProject);
                    return;
                }
                           
                var debugPath = 'bin/Debug/' + result.Project.PropertyGroup[0]
                    .TargetFramework[0] + '/' + nestTagCap + '.dll';

                launchConfig['configurations'][0]['program'] += debugPath;
                launchConfig['configurations'][0]['pipeTransport'].pipeArgs = [
                        "exec -i " + nestProject.container_name 
                    ];

                launchConfig['configurations'][1]['pipeTransport'].pipeArgs = [
                        "exec -i " + nestProject.container_name 
                    ];

                var launchJsonPath = path.resolve(path.resolve(nestHost, ".vscode"), "launch.json");
                progressStep("Emitting " + launchJsonPath, progressMarker);
    
                fs.writeFile(nestHost + '/.vscode/launch.json',
                    JSON.stringify(launchConfig, null, 2), 'utf-8', function(error) {
                    if (error !== null) {
                        progressStepFail('Failed to create ' + nestHost + '/.vscode/launch.json', progressMarker);
                        deferred.reject(nestProject);
                        return;
                    }
                    
                    progressStep("Launch file saved -> " + launchJsonPath, progressMarker);
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
function createNestProject(nestProject, progressMarker) : any
{
    progressStep("Attaching " + nestProject.container_name + " ...", progressMarker);
    var launchConfig = null;
    let deferred = Q.defer();

    var nestSourcePath = path.resolve(nestProject.environment['NEST_FOLDER_ROOT'], 'source');
    var nestHost = path.resolve(nestSourcePath, nestProject.environment['NEST_TAG_CAP']);

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
                    "name": "Debug Nest",
                    "type": "coreclr",
                    "request": "launch",
                    "cwd": "<-fill->",
                    "program": "<-fill->",
                    "sourceFileMap":  {
                    },
                    "env":  {
                    },
                    "pipeTransport": {
                        "pipeProgram": "docker",            
                        "pipeCwd": "${workspaceFolder}",
                        "pipeArgs": [
                        ],
                        "quoteArgs": false,
                        "debuggerPath": "/vsdbg/vsdbg"
                    }
                },
                {
                  "name": "Debug Unit Tests",
                  "type": "coreclr",
                  "request": "attach",
                  "processId" : "${command:unitTestProcId}",
                  "requireExactSource": false,
                  "sourceFileMap": {
                  },        
                  "pipeTransport": {
                    "pipeProgram": "docker",            
                    "pipeCwd": "${workspaceFolder}",
                    "pipeArgs": [
                    ],
                    "quoteArgs": false,
                    "debuggerPath": "/vsdbg/vsdbg"
                  }
                }                
            ]
        };

        var value;

        // strings with accents fail in the env
        Object.keys(nestProject.environment).forEach(function(key, index) {
            if (!isNaN(nestProject.environment[key]))
            {
                value = nestProject.environment[key].toString();
            }
            else
            {
                value = accents.remove(nestProject.environment[key].toString());
            }
            nestProject.environment[key] = value;
        });

        launchConfig['configurations'][0].env = nestProject.environment;
        launchConfig['configurations'][1].env = nestProject.environment;

        createNestAssets(nestProject, launchConfig, progressMarker)
            .then(function (result) {
                integrateGit(nestHost, progressMarker)
                .then(function () {                            
                    // done!
                    progressStep("Nest assets created.", progressMarker);
                    deferred.resolve(nestProject);                         
                })
                .catch(function (error) {
                    progressStepFail(nestProject.container_name + ' <- Faied to integrateGit [' + error + ']', progressMarker);
                    deferred.reject(nestProject);
                });  
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
                version: '2.0.0',
                configurations: [
                    {
                        "name": "Debug Nest",
                        "type": "coreclr",
                        "request": "launch",
                        "cwd": "<-fill->",
                        "program": "<-fill->",
                        "sourceFileMap": {
                        },
                        "env": {
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
                        "pipeTransport": {
                            "pipeProgram": "docker",            
                            "pipeCwd": "${workspaceFolder}",
                            "pipeArgs": [
                            ],
                            "quoteArgs": false,
                            "debuggerPath": "/vsdbg/vsdbg"
                        }
                    },
                    {
                      "name": "Debug Unit Tests",
                      "type": "coreclr",
                      "request": "attach",
                      "processId" : "${command:unitTestProcId}",
                      "requireExactSource": false,
                      "sourceFileMap": {
                      },               
                      "pipeTransport": {
                        "pipeProgram": "docker",            
                        "pipeCwd": "${workspaceFolder}",
                        "pipeArgs": [
                        ],
                        "quoteArgs": false,
                        "debuggerPath": "/vsdbg/vsdbg"
                      }
                    }
                ]
            };

            var browsePage = "http://" + nestProject.environment['NEST_DOCKER_MACHINE_IP'] + ":" + nestProject.environment['NEST_HTTP_PORT'];

            if (nestProject.environment['NEST_PLATFORM_TAG'] === 'api')
            {
                browsePage += "/swagger";
            }

            nestProject.environment['ASPNETCORE_ENVIRONMENT'] = "Development";
            nestProject.environment['ASPNETCORE_URLS'] = "http://*:5000";

            launchConfig['configurations'][0].launchBrowser.args = browsePage;
            launchConfig['configurations'][0].launchBrowser.windows.args = "/C start " + browsePage;

            Object.keys(nestProject.environment).forEach(function(key, index) {
                if (!isNaN(nestProject.environment[key]))
                {
                    value = nestProject.environment[key].toString();
                }
                else
                {
                    value = accents.remove(nestProject.environment[key].toString());
                }
                nestProject.environment[key] = value;
            });

            launchConfig['configurations'][0].env = nestProject.environment;

            createNestAssets(nestProject, launchConfig, progressMarker)
                .then(function (result) {
                    integrateGit(nestHost, progressMarker)
                        .then(function () {                            
                            integrateGit(path.resolve(nestSourcePath, "shared") , progressMarker)
                            .then(function () {
                                // done!
                                progressStep("Nest assets created.", progressMarker);
                                deferred.resolve(nestProject);
                            })
                            .catch(function (error) {
                                progressStepFail('Faied to integrateGit the shared folder [' + error + ']', progressMarker);
                                deferred.reject(nestProject);
                            });                         
                        })
                        .catch(function (error) {
                            progressStepFail(nestProject.container_name + ' <- Faied to integrateGit [' + error + ']', progressMarker);
                            deferred.reject(nestProject);
                        });                         
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
 * up the sendKickCI
 */
function sendKickCiCommand(nestSettings, progressMarker, cause) : any 
{
    let deferred = Q.defer();

    var buildCommand = ' curl ' + encodeUrl('http://127.0.0.1:8080/job/Local-CI/build?token=nesty');

    exec('docker exec ' + nestSettings['byKey']['build-jenkins'].container_name + buildCommand, (error, stdout, stderr) => {

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

        progressStep("kicked off a new continous integration session -> " + cause, progressMarker);
        // done!
        deferred.resolve(nestSettings);
    });

    return deferred.promise;
}

/**
 * up the sendKickCd
 */
function sendKickCdCommand(nestSettings, progressMarker, cause) : any 
{
    let deferred = Q.defer();

    var buildCommand = ' curl ' + encodeUrl('http://127.0.0.1:8080/job/Remote-Cd/build?token=nesty');

    exec('docker exec ' + nestSettings['byKey']['build-jenkins'].container_name + buildCommand, (error, stdout, stderr) => {

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

        progressStep("kicked off a new continous integration session -> " + cause, progressMarker);
        // done!
        deferred.resolve(nestSettings);
    });

    return deferred.promise;
}

/**
 * do the debug
 */
function debug(context) : any  {
    let debuggerPath = path.resolve(context.extensionPath, "debugger");
    let adapter = path.resolve(debuggerPath, "vsdbg-ui");

    if (os.platform() === 'win32') {
        adapter += ".exe";
    }
    else
    {
        fs.chmodSync(adapter, 0o755);
    }
    
    return {command: adapter};
}

/**
 * up the dataUp
 */
function dataUp() : any 
{    
    let deferred = Q.defer();
    var progressMarker = progressStart("data upload");

    const nestProject = getNestProject();
    if (nestProject === null)
    {
        deferred.reject();
        return deferred.promise;
    }

    if (getNestService("storage") === null)
    {
        deferred.reject();
        showError('A storage service has not been configured for this app.');
        return deferred.promise;
    }

    runCommand(nestProject, ['data', 'push'], progressMarker)
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
 * up the dataDown
 */
function dataDown() : any 
{
    let deferred = Q.defer();
    var progressMarker = progressStart("data download");

    const nestProject = getNestProject();
    if (nestProject === null)
    {
        deferred.reject();
        return deferred.promise;
    }
 
    if (getNestService("storage") === null)
    {
        deferred.reject();
        showError('A storage service has not been configured for this app.');
        return deferred.promise;
    }

    let quickPick = ['yes', 'no'];
    vscode.window.showQuickPick(quickPick, { placeHolder: 'Replace local Database from production?' }).then((val) => {
        if (val) {
            if (val === 'yes')
            {
                runCommand(nestProject, ['data', 'pull'], progressMarker)
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
            return;
        }
    });

   return deferred.promise;
}

/**
 * up the viewData
 */
function viewData() : any {

    var progressMarker = progressStart("view data");    
    var nestSettings = getNestSettings();
    if (!nestSettings)
    {
        progressStepFail('No nest settings found', progressMarker);
        return;
    }

    if (getNestService("storage", nestSettings) === null)
    {
        showError('A storage service has not been configured for this app.');
    }
    else
    {
        progressStep("login username - " + 
        nestSettings['services']['storage'].environment['NEST_APP_TAG'] + ", password - " +
        nestSettings['services']['storage'].environment['NEST_SERVICES_PASSWORD']
            , progressMarker);

        var url = 'http://' +
            nestSettings['services']['storage'].environment['NEST_DOCKER_MACHINE_IP'] + ':' +
            nestSettings['services']['storage'].environment['NEST_SERVICE_VIEW_PORT'];
                
        vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(url));
    }

    progressEnd(progressMarker);
}

/**
 * up the viewqueue
 */
function viewQueue() : any 
{
    var progressMarker = progressStart("view queue");
    var nestSettings = getNestSettings();
    if (!nestSettings)
    {
        progressStepFail('No nest settings found', progressMarker);
        return;
    }

    if (getNestService("batch", nestSettings) === null)
    {
        showError('A batch service has not been configured for this app.');
    }
    else
    {
        progressStep("login username - " + 
        nestSettings['services']['batch'].environment['NEST_APP_TAG'] + ", password - " +
        nestSettings['services']['batch'].environment['NEST_SERVICES_PASSWORD']
        , progressMarker);

        var url = 'http://' +
            nestSettings['services']['batch'].environment['NEST_DOCKER_MACHINE_IP'] + ':' +
            nestSettings['services']['batch'].environment['NEST_SERVICE_VIEW_PORT'];

        vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(url));
    }

    progressEnd(progressMarker);
}

/**
 * up the viewCiCd
 */
function viewCiCd() : any {

    var progressMarker = progressStart("view continous integration");
    var nestSettings = getNestSettings();
    if (!nestSettings)
    {
        progressStepFail('No nest settings found', progressMarker);
        return;
    }

    if (getNestService("build", nestSettings) === null)
    {
        showError('A build service has not been configured for this app.');
    }
    else
    {
        progressStep("login username - " + 
        nestSettings['services']['build'].environment['NEST_APP_TAG'] + ", password - " +
        nestSettings['services']['build'].environment['NEST_SERVICES_PASSWORD']
        , progressMarker);
        
        var url = 'http://' +
            nestSettings['services']['build'].environment['NEST_DOCKER_MACHINE_IP'] + ':' +
            nestSettings['services']['build'].environment['NEST_SERVICE_VIEW_PORT'];

        vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(url));
    }

    progressEnd(progressMarker);
}

/**
 * up the select
 */
function select() : any {

    var progressMarker = progressStart("select project");
    var nestSettings = getNestSettings();
    if (!nestSettings)
    {
        progressStepFail('No nest settings found', progressMarker);
        return;
    }

    var nests = ['shared'];

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
                var target = null;

                if (selected !== 'shared')
                {
                    var proj = nestSettings['byKey'][selected];
                    if (proj) {
                        target = proj.environment['NEST_TAG_CAP'];
                    }
                    else
                    {
                        vscode.window.showErrorMessage('The source code does not exist. Ensure to scaffold first.');
                    }    
                }
                else
                {
                    target = 'shared';
                }
                
                if (target !== null)
                {
                    var folder = path.resolve( getRootFolder(), 'source');
                    folder = path.resolve(folder, target);
                    let uri = vscode.Uri.parse(folder);
                    vscode.commands.executeCommand('vscode.openFolder', uri);
                }
            }
            progressEnd(progressMarker);
        });
}

/**
 * up the clear
 */
function clear() : any {
    let deferred = Q.defer();
    var progressMarker = progressStart("clear");

    const nestProject = getNestProject();
    if (nestProject === null)
    {
        deferred.reject();
        return deferred.promise;
    }

    runCommand(nestProject, ['deployment', 'clear'], progressMarker)
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
    {
        return false;
    }

    let deferred = Q.defer();
    var progressMarker = progressStart("cleaning");

    runCommand(nestProject, ['deployment', 'clean'], progressMarker)
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
    var progressMarker = progressStart("reset");
    let deferred = Q.defer();

    const rootFolder = getRootFolder();
    if (!rootFolder)
    {
        deferred.reject();
        return deferred.promise;    
    }

    if (getNestProject(false) !== null)
    {
        vscode.window.showErrorMessage('Run the reset command from the root folder.');
        deferred.reject();
        return deferred.promise;    
    }

    var nestSettings = getNestSettings();
    if (!nestSettings)
    {
        progressStepFail('No nest settings found', progressMarker);
        deferred.reject();
        return deferred.promise;
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

        var theDevkit = devkit(rootFolder);

        progressStep("Re-starting services ...", progressMarker);
        
        exec('docker-compose --file "'+ theDevkit +'" down', { 'cwd' : rootFolder },
            (error, stdout, stderr) => {

            if (error !== null) {
                progressStep("Ensure docker is installed and is accessible from this environment", progressMarker);
                progressStepFail(stderr, progressMarker);
                deferred.reject(nestSettings);
                return;
            }
            
            exec('docker-compose --file "'+ theDevkit +'" up -d', { 'cwd' : rootFolder },
                (error, stdout, stderr) => {
        
                if (error !== null) {
                    progressStep("Ensure docker is installed and is accessible from this environment", progressMarker);
                    progressStepFail(stderr, progressMarker);
                    deferred.reject();
                    return;
                }
        
                progressStep(stdout, progressMarker);
                progressStep(stderr, progressMarker);

                var services = [];

                Object.keys(nestSettings['byKey']).forEach(function(key, index) {
                    if (nestSettings['byKey'][key].environment['NEST_TAG'])
                    {
                        services.push(resetNest(key, nestSettings['byKey'][key], 
                            dockerMachineIP, progressMarker));
                    }
                    else if (nestSettings['byKey'][key].environment['NEST_APP_SERVICE'])
                    {
                        progressStep("Discovering services ...", progressMarker);
                        services.push(scaffoldService(key, nestSettings['byKey'][key], 
                            dockerMachineIP, progressMarker));
                    }
                });
    
                Q.allSettled(services).done(function (results) {
                    
                    // The docker port numbers have changed and they are 
                    // under the "byKey" branch. Make sure the app and worker
                    // branches are updated to the updated port nos
                                          
                    Object.keys(nestSettings['byKey']).forEach(function(key) {

                        if (typeof nestSettings['byKey'][key].environment['NEST_PLATFORM_TAG'] !== 'undefined')
                        {
                            switch (nestSettings['byKey'][key].environment['NEST_PLATFORM_TAG'])
                            {
                                case 'mvc':
                                case 'api': 
                                    nestSettings['app'].environment['NEST_HTTP_PORT']
                                        = nestSettings['byKey'][key].environment['NEST_HTTP_PORT'];
                                    break;
                            }            
                        }
                        if (typeof nestSettings['byKey'][key].environment['NEST_APP_SERVICE'] !== 'undefined')
                        {
                            switch (nestSettings['byKey'][key].environment['NEST_APP_SERVICE'])
                            {
                                case 'build':
                                case 'storage':
                                case 'batch':
                                {
                                    nestSettings['services'][nestSettings['byKey'][key].environment['NEST_APP_SERVICE']].environment['NEST_SERVICE_VIEW_PORT']
                                        = nestSettings['byKey'][key].environment['NEST_SERVICE_VIEW_PORT'];
                                    break;
                                }
                            }    
                        }
                    });                
    
                    saveNestSettings(rootFolder, nestSettings, progressMarker)
                    .then(function (value) {
                        progressEnd(progressMarker);
                        deferred.resolve(nestSettings);
                    })
                    .catch(function (error) {
                        progressStepFail(error, progressMarker);
                        deferred.reject();
                    });                   
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
    {
        return false;
    }

    let deferred = Q.defer();
    var progressMarker = progressStart("kill");

    runCommand(nestProject, ['nests', 'kill'], progressMarker)
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
    let deferred = Q.defer();
    var progressMarker = progressStart("restore");

    const nestProject = getNestProject();
    if (nestProject === null)
    {
        deferred.reject();
        return deferred.promise;
    }

    runCommand(nestProject, ['deployment', 'restore'], progressMarker)
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
    var progressMarker = progressStart("building");
    let deferred = Q.defer();

    const nestProject = getNestProject();
    if (nestProject === null)
    {
        deferred.reject();
        return deferred.promise;
    }

    var nestSettings = getNestSettings();
    if (!nestSettings)
    {
        progressStepFail('No nest settings found', progressMarker);
        deferred.reject();
        return;
    }

    runCommand(nestProject, ['deployment', 'build'], progressMarker)
        .then(function (value) {
            
            sendKickCiCommand(nestSettings, progressMarker, "project " + 
                nestProject.environment['NEST_TAG_CAP'] + " was built" )
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

   return deferred.promise;
}

/**
 * up the unit test clean build
 */
function unitTestCleanBuild() : any {
    const nestProject = getNestProject();
    if (nestProject === null)
    {
        return false;
    }

    var progressMarker = progressStart("clean building unit tests");
    let deferred = Q.defer();

    var nestSettings = getNestSettings();
    if (!nestSettings)
    {
        progressStepFail('No nest settings found', progressMarker);
        deferred.reject();
        return;
    }

    runCommand(nestProject, ['deployment', 'clean_build_tests'], progressMarker)
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
 * pull the nest
 */
function pull() : any {
    let deferred = Q.defer();
    var progressMarker = progressStart("pull content");

    const nestProject = getNestProject();
    if (nestProject === null)
    {
        deferred.reject();
        return deferred.promise;
    }

    progressStep("*******************************************************************", progressMarker);
    progressStep("The pull command will download this project source code along with the shared", progressMarker);
    progressStep("source from the remote machine. All local project and shared source content will", progressMarker);
    progressStep("be replaced. ", progressMarker);

    progressStep("********************************************************************", progressMarker);
    progressStep("Confirm above you want to proceed.", progressMarker);

    let quickPick = ['yes', 'no'];
    vscode.window.showQuickPick(quickPick, { placeHolder: 'Replace local content from production?' }).then((val) => {
        if (val) {
            if (val === 'yes')
            {
                runCommand(nestProject, ['deployment', 'pull'], progressMarker)
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
            return;
        }
    });

   return deferred.promise;
}


/**
 * up the push
 */
function push() : any {
    var progressMarker = progressStart("push");
    let deferred = Q.defer();

    const nestProject = getNestProject();
    if (nestProject === null)
    {
        deferred.reject();
        return false;
    }

    progressStep("*******************************************************************", progressMarker);
    progressStep("This command will upload the project along with the shared source.", progressMarker);
    progressStep("The content pushed to the remote can be observed by opening a", progressMarker);
    progressStep("SSH terminal. Instructions on how to SSH is found in the following link.", progressMarker);
    progressStep("https://github.com/inkton/nester.develop/wiki/SSH-to-Production", progressMarker);
    progressStep("          ", progressMarker);
    progressStep("********************************************************************", progressMarker);
    progressStep("Confirm above you want to proceed.", progressMarker);

    let quickPick = ['yes', 'no'];
    vscode.window.showQuickPick(quickPick, { placeHolder: 'Ready to push the code?' }).then((val) => {
        if (val) {
            if (val === 'yes')
            {
                runCommand(nestProject, ['deployment', 'push'], progressMarker)
                .then(function (value) {
                    progressEnd(progressMarker);
                    deferred.resolve(nestProject);
                })
                .catch(function (error) {
                    progressStepFail(error, progressMarker);
                    deferred.reject();
                });        
            }
        }
        else
        {
            deferred.resolve();
        }
    });

   return deferred.promise;
}

/**
 * up the deploy
 */
function deploy() : any {
    var progressMarker = progressStart("deploy");
    let deferred = Q.defer();

    const nestProject = getNestProject();
    if (nestProject === null)
    {
        deferred.reject();
        return deferred.promise;
    }

    progressStep("*******************************************************************", progressMarker);
    progressStep("This command will restore, release build and restart the", progressMarker);
    progressStep("dependent services on the remote server.", progressMarker);
    progressStep("           ", progressMarker);
    progressStep("********************************************************************", progressMarker);
    progressStep("Confirm above you want to proceed.", progressMarker);

    let quickPick = ['yes', 'no'];
    vscode.window.showQuickPick(quickPick, { placeHolder: 'Ready to deploy?' }).then((val) => {
        if (val) {
            if (val === 'yes')
            {
                runCommand(nestProject, ['deployment', 'deploy'], progressMarker)
                .then(function (value) {
                    progressEnd(progressMarker);
                    deferred.resolve(nestProject);
                })
                .catch(function (error) {
                    progressStepFail(error, progressMarker);
                    deferred.reject();
                });        
            }
        }
        else
        {
            deferred.resolve();
        }
    });

   return deferred.promise;
}

/**
 * up the kickCi
 */
function kickCi() : any {
    var progressMarker = progressStart("kicking off a ci session");
    let deferred = Q.defer();

    var nestSettings = getNestSettings();
    if (!nestSettings)
    {
        progressStepFail('No nest settings found', progressMarker);
        deferred.reject();
        return deferred.promise;
    }    

    sendKickCiCommand(nestSettings, progressMarker, "on request")
    .then(function (value) {
        progressEnd(progressMarker);
        deferred.resolve();                    
    })
    .catch(function (error) {
        progressStepFail(error, progressMarker);
        deferred.reject();
    });

    return deferred.promise;   
}

/**
 * up the kickCd
 */
function kickCd() : any {
    var progressMarker = progressStart("kicking off a cd session");
    let deferred = Q.defer();

    var nestSettings = getNestSettings();
    if (!nestSettings)
    {
        progressStepFail('No nest settings found', progressMarker);
        deferred.reject();
        return deferred.promise;
    }

    sendKickCdCommand(nestSettings, progressMarker, "on request")
    .then(function (value) {
        progressEnd(progressMarker);
        deferred.resolve();                    
    })
    .catch(function (error) {
        progressStepFail(error, progressMarker);
        deferred.reject();
    });

    return deferred.promise;
}

/**
 * up the folderCreate
 */
async function folderCreate() : Promise<void> {
    let name = await vscode.window.showInputBox({
        prompt: 'Enter folder name',
        validateInput: (text: string): string | undefined => {                
            if (!text || text.trim().indexOf(' ') !== -1) {
                return 'The name cannot have spaces!';
            } else {
                return undefined;
            }
        }
    });
    
    var progressMarker = progressStart("creating a nest folder");
    let deferred = Q.defer();
    
    var nestSettings = getNestSettings();
    if (!nestSettings)
    {
        progressStepFail('No nest settings found', progressMarker);
        deferred.reject();
        return deferred.promise;
    }

    if (name && name.length > 0)
    {
        const rootFolder = getRootFolder(false);
        ensureSshPermissions(rootFolder);

        getGitFolderBranches(name)
        .then(function (branchPick) {
            if (branchPick.length > 0)
            {
                vscode.window.showErrorMessage('The folder already exists.');
            }
            else
            {
                const folderPath = getSourceFolder(false) + "/" + name;
                fs.mkdir(folderPath, { recursive: true }, (err) => {
                    if (err) {
                        throw err;
                    }
                    git(folderPath).init(function() {
                        var gitConfigPath = path.resolve(rootFolder, '.ssh_config').replace(/\\/g,"/");
                        const appNest = nestSettings['app'];
    
                        git(folderPath)
                            .addConfig('user.name', appNest.environment['NEST_CONTACT_ID'])
                            .addConfig('user.email', appNest.environment['NEST_CONTACT_EMAIL'])
                            .addConfig('core.fileMode', false)
                            .addConfig("core.sshcommand", "ssh -F " + gitConfigPath,
                            function() {              
                                git(folderPath).addRemote("origin", "nest:repository.git", function() {
                                    git(folderPath).fetch(function() {
                                        const newBranch = name.trim().toLowerCase() + "-master";                                    
                                        git(folderPath).checkoutLocalBranch(newBranch);
                                        progressStep(newBranch + " checked out in " + folderPath, progressMarker);
                                        progressEnd(progressMarker);
                                        deferred.resolve();                            
                                    });
                                });
                            }
                        );
                    });
                });
            }

            progressEnd(progressMarker);
            deferred.resolve();                    
        })
        .catch(function (error) {
            progressStepFail('No matching git hives found', progressMarker);
            progressStepFail(error, progressMarker);
            deferred.reject();
        });       
    }

    return deferred.promise;
}

/**
 * up the folderCreate
 */

async function folderFetch() : Promise<void> {

    let name = await vscode.window.showInputBox({
        prompt: 'Enter folder name',
        validateInput: (text: string): string | undefined => {                
            if (!text || text.trim().indexOf(' ') !== -1) {
                return 'The name cannot have spaces!';
            } else {
                return undefined;
            }
        }
    });
    
    var progressMarker = progressStart("fetch an existing folder from the remote");
    let deferred = Q.defer();
    
    var nestSettings = getNestSettings();
    if (!nestSettings)
    {
        progressStepFail('No nest settings found', progressMarker);
        deferred.reject();
        return deferred.promise;
    }

    if (name && name.length > 0)
    {
        const rootFolder = getRootFolder(false);
        ensureSshPermissions(rootFolder);

        getGitFolderBranches(name)
        .then(function (branchPick) {
            if (branchPick.length === 0)
            {
                vscode.window.showErrorMessage('There are no folders with the name ' + name);
            }
            else
            {
                const folderPath = getSourceFolder(false) + "/" + name;
                fs.mkdir(folderPath, { recursive: true }, (err) => {
                    if (err) {
                        throw err;
                    }
                    git(folderPath).init(function() {
                        var gitConfigPath = path.resolve(rootFolder, '.ssh_config').replace(/\\/g,"/");
                        const appNest = nestSettings['app'];
    
                        git(folderPath)
                            .addConfig('user.name', appNest.environment['NEST_CONTACT_ID'])
                            .addConfig('user.email', appNest.environment['NEST_CONTACT_EMAIL'])
                            .addConfig('core.fileMode', false)
                            .addConfig("core.sshcommand", "ssh -F " + gitConfigPath,
                            function() {              
                                git(folderPath).addRemote("origin", "nest:repository.git", function() {
                                    git(folderPath).fetch(function() {
                                        if (branchPick.length === 1)
                                        {
                                            git(folderPath).checkout([branchPick[0], '--track', '--force']);
                                            progressStep(branchPick[0] + " checked out in " + folderPath, progressMarker);                                            
                                        }
                                        else
                                        {
                                            vscode.window.showQuickPick(branchPick, { placeHolder: 'Select branch' }).then((branch) => {
                                                if (branch) {                                                    
                                                    git(folderPath).checkout([branch, '--track', '--force']);
                                                    progressStep(branch + " checked out in " + folderPath, progressMarker);        
                                                }
                                            });    
                                        }
    
                                        progressEnd(progressMarker);
                                        deferred.resolve();                                                                                                           
                                    });
                                });
                            }
                        );
                    });
                });
            }

            progressEnd(progressMarker);
            deferred.resolve();                    
        })
        .catch(function (error) {
            progressStepFail('No matching git hives found', progressMarker);
            progressStepFail(error, progressMarker);
            deferred.reject();
        });    
    }

    return deferred.promise;
}


/**
 * build the nest
 */
function buildNest(nest, progressMarker) : any
{
    let deferred = Q.defer();
    let result = new DeferredResult(nest);

    progressStep("Project " + nest.container_name + " building ...", progressMarker);

    runCommand(nest, ['deployment','build'], progressMarker)
        .then(function () {
            runCommand(nest, ['deployment', 'clean_build_tests'], progressMarker)
                .then(function (value) {
                    // done!
                    result.success = true;
                    deferred.resolve(result);
                })
                .catch(function (error) {
                    progressStepFail(nest.container_name + ' project unit-test build failed [' + error + ']', progressMarker);
                    deferred.reject();
            });
    })
    .catch(function (error) {
        progressStepFail(nest.container_name + ' project build failed [' + error + ']', progressMarker);
        deferred.reject(result);
    });

    return deferred.promise;
}

/**
 * up the scaffold nesst
 */
function scaffoldNest(key, nest, dockerMachineIP, progressMarker) : any
{
    let deferred = Q.defer();
    let result = new DeferredResult(nest);

    nest.environment['NEST_DOCKER_MACHINE_IP'] = dockerMachineIP;
    progressStep("Attaching " + nest.container_name + ", this may take a minute or two ...", progressMarker);

    runCommand(nest, ['app', 'attach'], progressMarker)
        .then(function () {

        progressStep("Attach ok ... pulling from production " + nest.container_name, progressMarker);

        runCommand(nest, ['deployment', 'pull'], progressMarker)
            .then(function () {

            progressStep("Code for " + nest.container_name + " deployment downloaded, now restoring ..", progressMarker);

            runCommand(nest, ['deployment', 'restore'], progressMarker)
                .then(function () {

                progressStep("Resoration complete of " + nest.container_name + ", now building ..", progressMarker);
                    
                buildNest(nest, progressMarker)
                    .then(function () {

                        progressStep("Building of " + nest.container_name + " now complete, now creating nest project config ..", progressMarker);

                        createNestProject(nest, progressMarker)
                            .then(function () {
                                // done!                                
                                progressStep("Nest project for " + nest.container_name + " created.", progressMarker);
                                result.success = true;
                                deferred.resolve(result);
                            })
                            .catch(function (error) {
                                progressStepFail(nest.container_name + ' project create failed', progressMarker);
                                deferred.reject(result);
                                return;
                            });     
                    })
                    .catch(function (error) {
                        progressStepFail(error, progressMarker);
                        deferred.reject(result);
                    });
                })
                .catch(function (error) {
                    progressStepFail(nest.container_name + ' project unit-test build failed [' + error + ']', progressMarker);
                    deferred.reject();
                });
            })
            .catch(function (error) {
                progressStepFail(nest.container_name + ' project restore failed [' + error + ']', progressMarker);
                deferred.reject(result);
            });
    })
    .catch(function (error) {
        progressStepFail('Attach failed [' + error + ']', progressMarker);
        deferred.reject(result);
        return;
    });

    return deferred.promise;
}

/**
 * up the scaffold nesst
 */
function scaffoldService(key, nest, dockerMachineIP, progressMarker) : any
{
    let deferred = Q.defer();
    let result = new DeferredResult(nest);

    nest.environment['NEST_DOCKER_MACHINE_IP'] = dockerMachineIP;
    progressStep("Discovering " + nest.container_name + " ports, this may take a minute or two ...", progressMarker);

    var viewPort = '';
    if (key === 'storage-mariadb')
    {
        viewPort = ' 80';
    }
    else if (key === 'batch-rabbitmq')
    {
        viewPort = ' 15672';
    }
    else if (key === 'build-jenkins')
    {
        viewPort = ' 8080';
    }

    exec('docker port ' + nest.container_name + viewPort, (error, stdout, stderr) => {

        if (error !== null) {
            progressStep("Ensure docker is installed and is accessible from this environment", progressMarker);
            progressStepFail(stderr, progressMarker);
            deferred.reject(result);
            return;
        }

        if (stdout !== null)
        {
            progressStep(stdout, progressMarker);
        }

        progressStep("Port found ... saving info on " + nest.container_name, progressMarker);
        var arr = stdout.trim().split(":");
        nest.environment['NEST_SERVICE_VIEW_PORT'] = arr[1];
        // done!
        result.success = true;
        deferred.resolve(result);
    });

    return deferred.promise;
}

/**
 * reset nesst
 */
function resetNest(key, nest, dockerMachineIP, progressMarker) : any
{
    let deferred = Q.defer();
    let result = new DeferredResult(nest);

    nest.environment['NEST_DOCKER_MACHINE_IP'] = dockerMachineIP;
    progressStep("Attaching " + nest.container_name + ", this may take a minute or two ...", progressMarker);

    runCommand(nest, ['app', 'attach'], progressMarker)
        .then(function () {

        progressStep("Attach ok ... pulling from production " + nest.container_name, progressMarker);
                  
        buildNest(nest, progressMarker)
            .then(function () {

                progressStep("Building of " + nest.container_name + " now complete, now creating nest project config ..", progressMarker);

                createNestProject(nest, progressMarker)
                    .then(function () {
                        // done!                                
                        progressStep("Nest project for " + nest.container_name + " created.", progressMarker);
                        result.success = true;
                        deferred.resolve(result);
                    })
                    .catch(function (error) {
                        progressStepFail(nest.container_name + ' project create failed', progressMarker);
                        deferred.reject(result);
                        return;
                    });     
            })
            .catch(function (error) {
                progressStepFail(error, progressMarker);
                deferred.reject(result);
            }); 
    })
    .catch(function (error) {
        progressStepFail('Attach failed [' + error + ']', progressMarker);
        deferred.reject(result);
        return;
    });

    return deferred.promise;
}

function setupGit(rootFolder, nestSettings, progressMarker)
{
    let deferred = Q.defer();
    let result = new DeferredResult(null);
            
    const appNest = nestSettings['app'];
    const appTag = appNest.environment['NEST_APP_TAG'];
    const contactId = appNest.environment['NEST_CONTACT_ID'];

    var treeKey = Buffer.from(appNest.environment['NEST_TREE_KEY'], 
        'base64').toString('ascii').replace(/\\n/g, '\n');

    fs.writeFile(path.resolve(rootFolder, 'tree_key'),
        treeKey, 'utf-8', function(error) {

        if (error !== null) {
            progressStepFail('.tree_key save failed', progressMarker);
            deferred.reject(result);
            return;
        }

        hidefile.hide(path.resolve(rootFolder, 'tree_key'));
        var contactKey = Buffer.from(appNest.environment['NEST_CONTACT_KEY'], 
            'base64').toString('ascii').replace(/\\n/g, '\n');

        fs.writeFile(path.resolve(rootFolder, 'contact_key'),
            contactKey, 'utf-8', function(error) {

            if (error !== null) {
                progressStepFail('.contact_key save failed', progressMarker);
                deferred.reject(result);
                return;
            }

            hidefile.hide(path.resolve(rootFolder, 'contact_key'));            
            ensureSshPermissions(rootFolder);

            var treeKeyPath = path.resolve(rootFolder, '.tree_key');
            var contactKeyPath = path.resolve(rootFolder, '.contact_key');

            fs.writeFile(path.resolve(rootFolder, 'ssh_config'),
`Host nest
    HostName ${appTag}.nestapp.yt
    User ${contactId}
    UserKnownHostsFile ${treeKeyPath}
    IdentityFile ${contactKeyPath}`, 'utf-8', function(error) {

                if (error !== null) {
                    progressStepFail('Failed to create ' + path.resolve(rootFolder, '.ssh_config'), progressMarker);
                    deferred.reject(result);              
                    return;
                }

                hidefile.hide(path.resolve(rootFolder, 'ssh_config'));

                // done!
                progressStep("Git setup on root folder complete .. ", progressMarker);
                result.success = true;
                deferred.resolve(result);                
            });
        }); 
    }); 

    return deferred.promise;
}

function integrateGit(gitFolder, progressMarker)
{
    let deferred = Q.defer();
    let result = new DeferredResult(null);

    const rootFolder = getRootFolder();
    if (!rootFolder)
    {
        deferred.reject();
        return deferred.promise;
    }

    var gitConfigPath = path.resolve(rootFolder, '.ssh_config');
    var gitInit = `git config --local core.sshcommand "ssh -F ${gitConfigPath}" && git config --local core.fileMode false`.replace(/\\/g,"/");

    exec(gitInit, { 'cwd' : gitFolder},
        (error, stdout, stderr) => {

        if (stdout !== null)
        {
            progressStep(stdout, progressMarker);
        }

        if (error !== null) {
            progressStepFail(stderr, progressMarker);
            deferred.reject(result);
            return;
        }

        progressStep("Integration of git folder complete -> " + gitFolder, progressMarker);
        deferred.resolve(result);
    });

    return deferred.promise;
}

/**
 * up the scaffold
 */
function scaffoldUp() : any 
{
    var progressMarker = progressStart("scaffold up");
    let deferred = Q.defer();

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
                deferred.reject();
                return deferred.promise;
            }                        
        }        
    })
    .catch(function (exception) {
        deferred.reject();
        showError("Failed to check if Git is installed");
    });

    const rootFolder = getRootFolder();
    if (!rootFolder)
    {
        deferred.reject();
        return deferred.promise;
    }

    if (getNestProject(false) !== null)
    {
        vscode.window.showErrorMessage('Run the scaffold command from the root folder.');
        deferred.reject();
        return;
    }

    if (fs.existsSync(path.resolve(rootFolder, 'source')))
    {
        vscode.window.showErrorMessage('A scaffold already exist. Down the scafold before proceeding.');
        deferred.reject();
        return deferred.promise;
    }

    var nestSettings = discoverNestSettings(progressMarker);
    if (!nestSettings)
    {
        progressStepFail('No nest settings found', progressMarker);
        deferred.reject();
        return deferred.promise;
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

        exec('docker-compose --file "'+ theDevkit +'" up -d', { 'cwd' : rootFolder },
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

            try
            {
                Object.keys(nestSettings['byKey']).forEach(function(key, index) {                    
    
                    if (nestSettings['byKey'][key].environment['NEST_TAG'])
                    {
                        progressStep("Downloading the source ...", progressMarker);
                        services.push(scaffoldNest(key, nestSettings['byKey'][key], dockerMachineIP, progressMarker));
                    }
                    else if (nestSettings['byKey'][key].environment['NEST_APP_SERVICE'])
                    {
                        progressStep("Discovering services ...", progressMarker);
                        services.push(scaffoldService(key, nestSettings['byKey'][key], dockerMachineIP, progressMarker));
                    }
                });

            } catch (e) {
                progressStep(e.toString(), progressMarker);
                progressStep("Scaffolding failed.", progressMarker);
                deferred.reject(nestSettings);                
            }

            Q.allSettled(services).done(function (results) {

                progressStep("Checking nest create results ...", progressMarker);

                results.forEach(function (result) {
                    if (result.state !== "fulfilled") {
                        if (result.value.subject.environment['NEST_TAG'])
                        {
                            progressStepFail("The scaffoldding of " + 
                                result.value.subject.environment['NEST_TAG'] + " failed", progressMarker);
                        }
                        else
                        {
                            progressStepFail("The scaffoldding of" + 
                                result.value.subject.environment['NEST_APP_SERVICE'] + " failed", progressMarker);
                        }

                        progressStep("Scaffolding failed.", progressMarker);
                        deferred.reject(nestSettings);
                        return;                            
                    }                           
                });

                progressStep("Setting up git ...", progressMarker);

                setupGit(rootFolder, nestSettings, progressMarker)
                    .then(function () {
                        progressStep("Saving nest settings ...", progressMarker);
                        saveNestSettings(rootFolder, nestSettings, progressMarker)
                            .then(function (value) {
                                progressEnd(progressMarker);
                                deferred.resolve(nestSettings);
                            })
                            .catch(function (error) {
                                progressStepFail(error, progressMarker);
                                deferred.reject();
                            });                                        
                    })
                    .catch(function (error) {
                        progressStepFail("Failed to setup Git", progressMarker);
                        deferred.reject();
                        return;
                    });
                });
        });
    });

   return deferred.promise;
}

/**
 * down the scaffold
 */
function scaffoldDown() : any 
{
    var progressMarker = progressStart("scaffold down");
    let deferred = Q.defer();

    const rootFolder = getRootFolder();
    if (!rootFolder)
    {
        deferred.reject();
        return deferred.promise;    
    }

    if (getNestProject(false) !== null)
    {
        vscode.window.showErrorMessage('Run the scaffold command from the root folder.');
        deferred.reject();
        return deferred.promise;    
    }

    let quickPick = ['yes', 'no'];
       vscode.window.showQuickPick(quickPick, { placeHolder: 'Remove all local assets of this project?' }).then((val) => {
        if (val) {
            if (val === 'yes')
            {
                progressStep("Working, this may take a while ...", progressMarker);                
                var theDevkit = devkit(rootFolder);
                                           
                exec('docker-compose --file "'+ theDevkit +'" down', { 'cwd' : rootFolder },
                    (error, stdout, stderr) => {
                        
                    if (stdout !== null)
                    {
                        progressStep(stdout, progressMarker);
                    }
                    if (stderr !== null)
                    {
                        progressStep(stderr, progressMarker);
                    }
            
                    try
                    {
                        var files = fs.readdirSync(rootFolder);

                        for (var i in files){                            
                            var name = path.resolve(rootFolder, files[i]);
                            
                            if (name === theDevkit)
                            {
                                continue;
                            }

                            if (fs.statSync(name).isDirectory())
                            {
                                deleteFolderRecursive(name);
                            } else {
                                fs.unlinkSync(name);
                            }

                            progressStep("Removed " + name, progressMarker);
                        }
    
                    } catch (exception) {
                        progressStep(exception.toString(), progressMarker);
                    }

                    progressEnd(progressMarker);
                    deferred.resolve();
                });            
            }
        } else {
            return;
        }
    });

   return deferred.promise;
}

/**
 * up the unit test debug host
 */
function unitTestDebugHost() : any {

    let deferred = Q.defer();

    const nestProject = getNestProject();
    if (nestProject === null)
    {
        deferred.reject();
        return deferred.promise;
    }
    
    exec('docker exec -t ' + nestProject.container_name + 
    '  nester deployment unit_test_debug_host', (error, stdout, stderr) => {
        
        if (error !== null) {
            deferred.reject("0");
        }
        else
        {
            var procId = stdout.trim();
            if (!isNaN(procId))
            {
                deferred.resolve(procId);
            }
            else
            {
                /* the comman fails when the build binary is not present
                   suggesting the unit tests were never built. 
                */
                showError("Please run 'Unit Test Clean Build' command first!");
                deferred.reject("0");
            }    
        }    
    });                   

    return deferred.promise;
}

/**
 * up the help
 */
function help() : any {

    var help = `
        ----------------------------------------------------------------------
                                    Nest Commands
        ----------------------------------------------------------------------
        Nest Scaffold Up, to build assets when new or updated.
        Nest Scaffold Down, to remove and clear all assets.
        Nest Select, to Select a project.
        Nest Restore, to restore the project.
        Nest Build, to build the project.
        Nest Clean, to clean the output.
        Nest Unit Test Clean Build, to clean build unit tests.
        Nest Reset, rebuilds the running services.
        Nest Pull, to pull from production.
        Nest Push, to push in production.
        Nest Checkout, to checkout source from a Git branch.
        Nest Deploy, to build and deploy production.
        Nest Kill, to kill the in-container run-time.
        Nest Data Up, to upload data to production.
        Nest Data Down, to download data into test.
        Nest View Data, to view test data.
        Nest View Queue, to view test queue.
        Nest View Ci/Cd, to view continous integration/deployment.
        Nest Kick Ci, to kick-off a new Ci session.
        Nest Kick Cd, to kick-off a new Cd session.
        Nest CoreCLR Down, to download the CoreCLR debuger.
        
        Visit https://github.com/inkton/nester.develop/wiki for more information.
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
    
function installCoreClrDebugger(context, debuggerPath) : any {
    var progressMarker = progressStart("installing core CLR (x64) debugger ..");
    progressStep("> Do not exit vscode until the install is complete ..", progressMarker);
    progressStep("> Install again with 'Nest CoreCLR Down' command if there is an interruption  ..", progressMarker);

    let deferred = Q.defer();

    let platform = os.platform();
    let archive = null;
    let downloadUrl = "https://vsdebugger.blob.core.windows.net";

    switch (platform) {
        case 'win32':
            archive = "coreclr-debug-win7-x64.zip";
            break;
        case 'darwin':
            archive = "coreclr-debug-osx-x64.zip";
            break;
        case 'linux':
            archive = "coreclr-debug-linux-x64.zip";
            break;
        default:
            progressStepFail(`Unsupported platform: ${platform}`, progressMarker);
            return deferred.reject();
    }
   
    downloadUrl += archive;
    progressStep("Setting up the debugger ...", progressMarker);
    var zippedFile = path.resolve(os.tmpdir(), archive);

    const options = {
        hostname: "vsdebugger.blob.core.windows.net",
        port: 443,
        path: '/coreclr-debug-1-16-0/' + archive,
        method: 'GET'
      };

    var file = fs.createWriteStream(zippedFile);
    https.get(options, function(response) {
        response.pipe(file);
        file.on('finish', function() {
            file.close();  // close() is async, call cb after close completes.

            progressStep("Nearly there ..", progressMarker);

            var zip = new streamZip({
                file: zippedFile, 
                storeEntries: true
            });
                
            zip.on('ready', () => {
                fs.mkdirSync(debuggerPath);
                zip.extract(null, debuggerPath, (error, count) => {
                    if (error)
                    {
                        progressStepFail("Failed to download the debugger - " + error, progressMarker);
                        deferred.reject();                                    
                    }
                    else
                    {
                        progressStep('Installed', progressMarker);
                        progressEnd(progressMarker);
                        deferred.resolve();
                    }
                    zip.close();
                });
            });                
        });
    }).on('error', function(error) { // Handle errors
        fs.unlink(archive); // Delete the file async. (But we don't check the result)            
        progressStepFail("Failed to download the debugger", progressMarker);
        deferred.reject(); 
    });

    return deferred.promise;
}

/**
 * check the debugger
 */
function checkDebugger(context) : any {
    let debuggerPath = path.resolve(context.extensionPath, "debugger");

    if (!fs.existsSync(debuggerPath)) {
        installCoreClrDebugger(context, debuggerPath);
    }
}

/**
 * force download the debugger
 */
function forceDownloadDebugger(context) : any {
    let debuggerPath = path.resolve(context.extensionPath, "debugger");

    if (fs.existsSync(debuggerPath)) {
        // delete the folder if alredy exist and re-download
        deleteFolderRecursive(debuggerPath);
    }

    installCoreClrDebugger(context, debuggerPath);
}

/**
 * offer git checkout
 */
function offerGitCheckout(isStarting) : any {

    const workspace = vscode.workspace;
    let deferred = Q.defer();

    function doShared(thisSharedPath)
    {
        getGitFolderBranches('shared')
        .then(function (branchPick) {
            branchPick.push('None');
            vscode.window.showQuickPick(branchPick, { placeHolder: 'Checkout Shared?' }).then((branch) => {
                if (branch && branch !== 'None') {                                                    
                    git(thisSharedPath).checkout([branch, '--track', '--force']);
                }
            });                                
        })
        .catch(function (error) {
            deferred.reject();                    
        });  
    }

    git(workspace.rootPath).branch(function (err, branchSummary) {
        var doCheckout = false;
        if (isStarting)
        {
            if (branchSummary.current === "")
            {
                doCheckout = true;
            }    
        }
        else
        {
            doCheckout = true;      
        }

        if (doCheckout)
        {
            if (path.basename(workspace.rootPath) === 'shared')
            {
                // this is the shared folder
                doShared(workspace.rootPath);
            }
            else
            {
                // this is a nest project folder yet another type of 
                // folder user created folder exist but that is always
                // checked out when created.
                const nestProject = getNestProject(false);
                if (nestProject !== null)
                {
                    getGitFolderBranches(nestProject.environment['NEST_TAG'])
                    .then(function (branchPick) {
                        branchPick.push('None');
        
                        vscode.window.showQuickPick(branchPick, { placeHolder: 'Checkout?' }).then((branch) => {
                            if (branch && branch !== 'None') {
                                git(workspace.rootPath).checkout([branch, '--track', '--force']);
            
                                const rootFolder = getRootFolder();
                                if (!rootFolder)
                                {
                                    deferred.resolve();                            
                                    return deferred.promise;
                                }
            
                                var thisSharedPath = path.resolve(rootFolder, 'source');
                                thisSharedPath = path.resolve(thisSharedPath, 'shared');
                                
                                if (isStarting)
                                {
                                    // if first time set shared too ..
                                    doShared(thisSharedPath);
                                }
                            }
                        });                                
                    })
                    .catch(function (error) {
                        deferred.reject();                    
                    });        
                }        
            }
        }

        deferred.resolve();
    });

    return deferred.promise;
}


// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

    // Use the console to output diagnostic information (console.log) and errors (console.error)
    // This line of code will only be executed once when your extension is activated
    console.log('Congratulations, your extension "Nester Develop" is now active!');

    try {
        createNotifiers();
        checkDebugger(context);

        /* todo: the branch selection dialog gets refershed 
            over when opening the IDE. need to trap to the event after
            the window is open and settled.
        context.subscriptions.push(
            vscode.window.onDidChangeActiveTextEditor(
                function (e: any)
                {
                    if (isInstalled())
                    {
                        showProgress(offerGitCheckout(true));
                    }                 
                })
        );
        */

       if (isInstalled())
       {
           showProgress(offerGitCheckout(true));
       }                 

        let debugDisposable = vscode.commands.registerCommand('nester.debug', () => { return debug(context); });

        let dataUpDisposable = vscode.commands.registerCommand('nester.dataup', () => { return showProgress(dataUp); });
        let dataDownDisposable = vscode.commands.registerCommand('nester.datadown', () => { return showProgress(dataDown); });

        let viewdataDisposable = vscode.commands.registerCommand('nester.viewdata', () => viewData());
        let viewqueueDisposable = vscode.commands.registerCommand('nester.viewqueue', () => viewQueue());
        let viewCiCdcdDisposable = vscode.commands.registerCommand('nester.viewcicd', () => viewCiCd());

        let pushDisposable = vscode.commands.registerCommand('nester.push', () => { return showProgress(push); });
        let pullDisposable = vscode.commands.registerCommand('nester.pull', () => { return showProgress(pull); });
        
        let deployDisposable = vscode.commands.registerCommand('nester.deploy', () => { return showProgress(deploy); });

        let kickciDisposable = vscode.commands.registerCommand('nester.kickci', () => { return showProgress(kickCi); });
        let kickcdDisposable = vscode.commands.registerCommand('nester.kickcd', () => { return showProgress(kickCd); });

        let foldercreateDisposable = vscode.commands.registerCommand('nester.foldercreate', () => { return showProgress(folderCreate); });
        let folderfetchDisposable = vscode.commands.registerCommand('nester.folderfetch', () => { return showProgress(folderFetch); });

        let selectDisposable = vscode.commands.registerCommand('nester.select', () => select( ) );
        let cleanDisposable = vscode.commands.registerCommand('nester.clean', () => { return showProgress(clean); });
        let clearDisposable = vscode.commands.registerCommand('nester.clear', () => { return showProgress(clear); });
        let resetDisposable = vscode.commands.registerCommand('nester.reset', () => { return showProgress(reset); });
        let killDisposable = vscode.commands.registerCommand('nester.kill', () => { return showProgress(kill); });
        let buildDisposable = vscode.commands.registerCommand('nester.build', () => { return showProgress(build); });
        let unittestcleanbuildDisposable = vscode.commands.registerCommand('nester.unittestcleanbuild', () => { return showProgress(unitTestCleanBuild); });
        let helpDisposable = vscode.commands.registerCommand('nester.help', () => help( ) );
        let restoreDisposable = vscode.commands.registerCommand('nester.restore', () => { return showProgress(restore); });
        let scaffoldUpDisposable = vscode.commands.registerCommand('nester.scaffoldup', () => { return showProgress(scaffoldUp); });
        let scaffoldDownDisposable = vscode.commands.registerCommand('nester.scaffolddown', () => { return showProgress(scaffoldDown); });
        let unittestprocidDisposable = vscode.commands.registerCommand('nester.unittestprocid', () => { return unitTestDebugHost(); });
        let coreclrdownDisposable = vscode.commands.registerCommand('nester.coreclrdown', () => { return forceDownloadDebugger(context); });
        let checkoutisposable = vscode.commands.registerCommand('nester.checkout', () => { return offerGitCheckout(false); });        

        context.subscriptions.push(debugDisposable);
        context.subscriptions.push(dataUpDisposable);
        context.subscriptions.push(dataDownDisposable);
        context.subscriptions.push(viewdataDisposable);
        context.subscriptions.push(viewqueueDisposable);
        context.subscriptions.push(viewCiCdcdDisposable);
        context.subscriptions.push(pushDisposable);
        context.subscriptions.push(pullDisposable);
        context.subscriptions.push(deployDisposable);
        context.subscriptions.push(kickciDisposable);
        context.subscriptions.push(kickcdDisposable);
        context.subscriptions.push(foldercreateDisposable);
        context.subscriptions.push(folderfetchDisposable);
        context.subscriptions.push(selectDisposable);
        context.subscriptions.push(cleanDisposable);
        context.subscriptions.push(clearDisposable);
        context.subscriptions.push(resetDisposable);
        context.subscriptions.push(buildDisposable);
        context.subscriptions.push(unittestcleanbuildDisposable);
        context.subscriptions.push(killDisposable);
        context.subscriptions.push(restoreDisposable);
        context.subscriptions.push(scaffoldUpDisposable);        
        context.subscriptions.push(scaffoldDownDisposable);
        context.subscriptions.push(coreclrdownDisposable);
        context.subscriptions.push(helpDisposable);
        context.subscriptions.push(unittestprocidDisposable);        
        context.subscriptions.push(checkoutisposable);        

    } catch( exception ) {
        showError("Sorry, something went wrong with Nest services", exception);
    }
}

// this method is called when your extension is deactivated
export function deactivate() {
    destroyNotifiers();
}
