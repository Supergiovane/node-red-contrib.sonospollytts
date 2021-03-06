module.exports = function (RED) {
    'use strict';

    var AWS = require('aws-sdk');
    var fs = require('fs');
    var path = require("path");
    var formidable = require('formidable');
    const oOS = require('os');
    const sonos = require('sonos');

    AWS.config.update({
        region: 'us-east-1'
    });

    // Configuration Node Register
    function PollyConfigNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        node.noderedipaddress = typeof config.noderedipaddress === "undefined" ? "" : config.noderedipaddress;
        var params = {
            accessKeyId: node.credentials.accessKey,
            secretAccessKey: node.credentials.secretKey,
            apiVersion: '2016-06-10'
        };
        node.polly = new AWS.Polly(params);
        node.userDir = path.join(RED.settings.userDir, "sonospollyttsstorage"); // 09/03/2020 Storage of sonospollytts (otherwise, at each upgrade to a newer version, the node path is wiped out and recreated, loosing all custom files)
        node.whoIsUsingTheServer = ""; // Client node.id using the server, because only a sonospollytts node can use the serve at once.

        // 03/06/2019 you can select the temp dir
        //#region "SETUP PATHS"
        // 26/10/2020 Check for path and create it if doens't exists
        function setupDirectory(_aPath) {

            if (!fs.existsSync(_aPath)) {
                // Create the path
                try {
                    fs.mkdirSync(_aPath);
                    return true;
                } catch (error) { return false; }
            } else {
                return true;
            }
        }
        if (!setupDirectory(node.userDir)) {
            RED.log.error('SonosPollyTTS: Unable to set up MAIN directory: ' + node.userDir);
        }
        if (!setupDirectory(path.join(node.userDir, "ttsfiles"))) {
            RED.log.error('SonosPollyTTS: Unable to set up cache directory: ' + path.join(node.userDir, "ttsfiles"));
        } else {
            RED.log.info('SonosPollyTTS: TTS cache set to ' + path.join(node.userDir, "ttsfiles"));
        }
        if (!setupDirectory(path.join(node.userDir, "hailingpermanentfiles"))) {
            RED.log.error('SonosPollyTTS: Unable to set up hailing directory: ' + path.join(node.userDir, "hailingpermanentfiles"));
        } else {
            RED.log.info('SonosPollyTTS: hailing path set to ' + path.join(node.userDir, "hailingpermanentfiles"));
            // 09/03/2020 Copy defaults to the userDir
            fs.readdirSync(path.join(__dirname, "hailingpermanentfiles")).forEach(file => {
                try {
                    fs.copyFileSync(path.join(__dirname, "hailingpermanentfiles", file), path.join(node.userDir, "hailingpermanentfiles", file));
                } catch (error) { }
            });
        }
        if (!setupDirectory(path.join(node.userDir, "ttspermanentfiles"))) {
            RED.log.error('SonosPollyTTS: Unable to set up permanent files directory: ' + path.join(node.userDir, "ttspermanentfiles"));
        } else {
            RED.log.info('SonosPollyTTS: permanent files path set to ' + path.join(node.userDir, "ttspermanentfiles"));
            // 09/03/2020 // Copy the samples of permanent files into the userDir
            fs.readdirSync(path.join(__dirname, "ttspermanentfiles")).forEach(file => {
                try {
                    fs.copyFileSync(path.join(__dirname, "ttspermanentfiles", file), path.join(node.userDir, "ttspermanentfiles", file));
                } catch (error) { }
            });
        }
        //#endregion

        //#region SONOSPOLLY NODE
        // ######################################################
        // 21/03/2019 Endpoint for retrieving the default IP
        RED.httpAdmin.get("/sonospollyTTSGetEthAddress", RED.auth.needsPermission('PollyConfigNode.read'), function (req, res) {
            var oiFaces = oOS.networkInterfaces();
            var jListInterfaces = [];
            try {
                Object.keys(oiFaces).forEach(ifname => {
                    // Interface with single IP
                    if (Object.keys(oiFaces[ifname]).length === 1) {
                        if (Object.keys(oiFaces[ifname])[0].internal == false) jListInterfaces.push({ name: ifname, address: Object.keys(oiFaces[ifname])[0].address });
                    } else {
                        var sAddresses = "";
                        oiFaces[ifname].forEach(function (iface) {
                            if (iface.internal == false && iface.family === "IPv4") sAddresses = iface.address;
                        });
                        if (sAddresses !== "") jListInterfaces.push({ name: ifname, address: sAddresses });
                    }
                })
            } catch (error) { }
            if (jListInterfaces.length > 0) {
                res.json(jListInterfaces[0].address); // Retunr the first usable IP
            } else {
                res.json("NO ETH INTERFACE FOUND");
            }

        });

        // 20/03/2020 in the middle of coronavirus, get the sonos groups
        RED.httpAdmin.get("/sonosgetAllGroups", RED.auth.needsPermission('PollyConfigNode.read'), function (req, res) {
            var jListGroups = [];
            try {
                const discovery = new sonos.AsyncDeviceDiscovery()
                discovery.discover().then((device, model) => {
                    return device.getAllGroups().then((groups) => {
                        //RED.log.warn('Groups ' + JSON.stringify(groups, null, 2))
                        for (let index = 0; index < groups.length; index++) {
                            const element = groups[index];
                            jListGroups.push({ name: element.Name, host: element.host })
                        }
                        res.json(jListGroups)
                        //return groups[0].CoordinatorDevice().togglePlayback()
                    })
                }).catch(e => {
                    RED.log.warn('SonosPollyTTS: Error in discovery ' + e);
                    res.json("ERRORDISCOVERY");
                })
            } catch (error) { }
        });


        // 09/03/2020 Get list of filenames in hailing folder
        RED.httpAdmin.get("/getHailingFilesList", RED.auth.needsPermission('PollyConfigNode.read'), function (req, res) {
            var jListOwnFiles = [];
            var sName = "";
            try {
                fs.readdirSync(path.join(node.userDir, "hailingpermanentfiles")).forEach(file => {
                    if (file.indexOf("Hailing_") > -1) {
                        sName = file.replace("Hailing_", "").replace(".mp3", "");
                        jListOwnFiles.push({ name: sName, filename: file });
                    }
                });

            } catch (error) { }
            res.json(jListOwnFiles)
        });

        // 09/03/2020 Delete Hailing
        RED.httpAdmin.get("/deleteHailingFile", RED.auth.needsPermission('PollyConfigNode.read'), function (req, res) {
            // Delete the file
            try {
                var newPath = path.join(node.userDir, "hailingpermanentfiles", req.query.FileName);
                fs.unlinkSync(newPath)
            } catch (error) { }
            res.json({ status: 220 });
        });

        // 09/03/2020 Receive new hailing files from html
        RED.httpAdmin.post("/sonospollyttsHailing", function (req, res) {
            var form = new formidable.IncomingForm();
            form.parse(req, function (err, fields, files) {
                if (err) { };
                // Allow only mp3
                if (files.customHailing.name.indexOf(".mp3") !== -1) {
                    var newPath = path.join(node.userDir, "hailingpermanentfiles", "Hailing_" + files.customHailing.name);
                    fs.rename(files.customHailing.path, newPath, function (err) { });
                }
            });
            res.json({ status: 220 });
            res.end;
        });

        // 26/10/2020 Supergiovane, get the updated voice list from AWS. 
        RED.httpAdmin.get("/pollygetvoices", RED.auth.needsPermission('PollyConfigNode.read'), function (req, res) {
            // node.refreshVoices().then(function (resolve) {
            //     res.json(resolve);
            // }).catch(function (reject) { 
            //     res.json(reject);
            //  });
            
            var jListVoices = [];
            try {
                // https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/Polly.html#describeVoices-property
                var jfiltroVoci = {
                    //Engine: standard | neural,
                    //IncludeAdditionalLanguageCodes: true 
                    //LanguageCode: arb | cmn-CN | cy-GB | da-DK | de-DE | en-AU | en-GB | en-GB-WLS | en-IN | en-US | es-ES | es-MX | es-US | fr-CA | fr-FR | is-IS | it-IT | ja-JP | hi-IN | ko-KR | nb-NO | nl-NL | pl-PL | pt-BR | pt-PT | ro-RO | ru-RU | sv-SE | tr-TR,
                    //NextToken: "STRING_VALUE"
                };
                node.polly.describeVoices(jfiltroVoci, function (err, data) {
                    if (err) {
                        RED.log.warn('SonosPollyTTS: Error getting polly voices ' + err);
                        jListVoices.push({ name: "Error retrieving voices. Check your AWS credentials and restart node-red", id: "Ivy" })
                        res.json(jListVoices)
                    } else {
                        for (let index = 0; index < data.Voices.length; index++) {
                            const oVoice = data.Voices[index];
                            jListVoices.push({ name: oVoice.LanguageName + " (" + oVoice.LanguageCode + ") " + oVoice.Name + " - " + oVoice.Gender, id: oVoice.Id })
                        }
                        res.json(jListVoices)
                    }
                });

            } catch (error) {
                jListVoices.push({ name: "Error " + error, id: "Ivy" })
                res.json(jListVoices)
            }
        });

        // ########################################################
        //#endregion



        //#region OWNFILE NODE
        // ######################################################

        // Receive new files from html
        RED.httpAdmin.post("/sonospollyttsOwnFile", function (req, res) {
            var form = new formidable.IncomingForm();
            form.parse(req, function (err, fields, files) {
                if (err) { };
                // Allow only mp3
                if (files.customTTS.name.indexOf(".mp3") !== -1) {
                    var newPath = path.join(node.userDir, "ttspermanentfiles", "OwnFile_" + files.customTTS.name);
                    fs.rename(files.customTTS.path, newPath, function (err) { });
                }
            });
            res.json({ status: 220 });
            res.end;
        });

        // 27/02/2020 Get list of filenames starting with OwnFile_
        RED.httpAdmin.get("/getOwnFilesList", RED.auth.needsPermission('PollyConfigNode.read'), function (req, res) {
            var jListOwnFiles = [];
            var sName = "";
            try {
                fs.readdirSync(path.join(node.userDir, "ttspermanentfiles")).forEach(file => {
                    if (file.indexOf("OwnFile_") > -1) {
                        sName = file.replace("OwnFile_", '').replace(".mp3", '');
                        jListOwnFiles.push({ name: sName, filename: file });
                    }
                });

            } catch (error) { }
            res.json(jListOwnFiles)
        });

        // 27/02/2020 Delete OwnFile_
        RED.httpAdmin.get("/deleteOwnFile", RED.auth.needsPermission('PollyConfigNode.read'), function (req, res) {
            try {
                if (req.query.FileName == "DELETEallFiles") {
                    // Delete all OwnFiles_
                    try {
                        fs.readdir(path.join(node.userDir, "ttspermanentfiles"), (err, files) => {
                            files.forEach(function (file) {
                                if (file.indexOf("OwnFile_") !== -1) {
                                    RED.log.warn("SonospollyTTS: Deleted file " + path.join(node.userDir, "ttspermanentfiles", file));
                                    try {
                                        fs.unlinkSync(path.join(node.userDir, "ttspermanentfiles", file));
                                    } catch (error) { }
                                }
                            });
                        });

                    } catch (error) { }
                } else {
                    // Delete only one file
                    try {
                        var newPath = path.join(node.userDir, "ttspermanentfiles", req.query.FileName);
                        try {
                            fs.unlinkSync(newPath)
                        } catch (error) { }

                    } catch (error) { }
                }
            } catch (err) {
            }
            res.json({ status: 220 });
        });
        // ########################################################
        //#endregion

        node.oWebserver; // 11/11/2019 Stores the Webserver
        node.purgediratrestart = config.purgediratrestart || "leave"; // 26/02/2020
        node.noderedport = typeof config.noderedport === "undefined" ? "1980" : config.noderedport;
        // 11/11/2019 NEW in V 1.1.0, changed webserver behaviour. Redirect pre V. 1.1.0 1880 ports to the nde default 1980
        if (node.noderedport.trim() == "1880") {
            RED.log.warn("SonosPollyTTS-config: The webserver port ist 1880. Please change it to another port, not to conflict with default node-red 1880 port. I've changed this temporarly for you to 1980");
            node.noderedport = "1980";
        }
        node.sNoderedURL = "http://" + node.noderedipaddress.trim() + ":" + node.noderedport.trim(); // 11/11/2019 New Endpoint to overcome https problem.
        RED.log.info('SonosPollyTTS-config: Node-Red node.js Endpoint will be created here: ' + node.sNoderedURL + "/tts");

        // 26/02/2020
        if (node.purgediratrestart === "purge") {
            // Delete all files, that are'nt OwnFiles_
            try {
                fs.readdirSync(path.join(node.userDir, "ttsfiles"), (err, files) => {
                    try {
                        if (files.length > 0) {
                            files.forEach(function (file) {
                                RED.log.info("SonospollyTTS-config: Deleted TTS file " + path.join(node.userDir, "ttsfiles", file));
                                try {
                                    fs.unlinkSync(path.join(node.userDir, "ttsfiles", file));
                                } catch (error) {
                                }
                            });
                        };
                    } catch (error) {

                    }

                });
            } catch (error) { }
        };




        // 11/11/2019 CREATE THE ENDPOINT
        // #################################
        const http = require('http')
        const sWebport = node.noderedport.trim();
        const requestHandler = (req, res) => {
            try {

                var url = require('url');
                var url_parts = url.parse(req.url, true);
                var query = url_parts.query;

                res.setHeader('Content-Disposition', 'attachment; filename=tts.mp3')
                if (fs.existsSync(query.f)) {
                    var readStream = fs.createReadStream(query.f);
                    readStream.on("error", function (err) {
                        fine(err);
                    });
                    readStream.pipe(res);
                    res.end;
                } else {
                    RED.log.error("SonosPollyTTS-config: Playsonos RED.httpAdmin file not found: " + query.f);
                    res.write("File not found");
                    res.end();
                }

            } catch (error) {
                RED.log.error("SonosPollyTTS-config: Playsonos RED.httpAdmin error: " + error + " on: " + query.f);
            }
            function fine(err) {
                RED.log.error("SonosPollyTTS-config: Playsonos error opening stream : " + query.f + ' : ' + error);
                res.end;
            }
        }


        try {
            node.oWebserver = http.createServer(requestHandler);
            node.oWebserver.on('error', function (e) {
                RED.log.error("SonosPollyTTS-config: " + node.ID + " error starting webserver on port " + sWebport + " " + e);
            });
        } catch (error) {
            // Already open. Close it and redo.
            RED.log.error("SonosPollyTTS-config: Webserver creation error: " + error);
        }

        try {
            node.oWebserver.listen(sWebport, (err) => {
                if (err) {
                    RED.log.error("SonosPollyTTS-config: error listening webserver on port " + sWebport + " " + err);
                }
            });

        } catch (error) {
            // In case oWebserver is null
            RED.log.error("SonosPollyTTS-config: error listening webserver on port " + sWebport + " " + error);
        }
        // #################################




        node.on('close', function (done) {
            // 11/11/2019 Close the Webserver
            try {
                node.oWebserver.close(function () { RED.log.info("SonosPollyTTS: Webserver UP. Closing down."); });
            } catch (error) {

            }
            setTimeout(function () {
                // Wait some time to allow time to do promises.
                done();
            }, 500);
        });


    }
    RED.nodes.registerType("sonospollytts-config", PollyConfigNode, {
        credentials: {
            accessKey: { type: "text" },
            secretKey: { type: "password" }
        }
    });

}

