Components.utils.import("resource://gre/modules/FileUtils.jsm");
Components.utils.import("resource://gre/modules/osfile.jsm");
var EventUtils = Components.utils.import("resource://zotero-unit/EventUtils.jsm");

var ZoteroUnit = Components.classes["@mozilla.org/commandlinehandler/general-startup;1?type=zotero-unit"].
	             getService(Components.interfaces.nsISupports).
	             wrappedJSObject;
var dump = ZoteroUnit.dump;

function quit(failed) {
	// Quit with exit status
	if(!failed) {
		OS.File.writeAtomic(FileUtils.getFile("ProfD", ["success"]).path, new Uint8Array(0));
	}
	if(!ZoteroUnit.noquit) {
		setTimeout(function () {
			Components.classes['@mozilla.org/toolkit/app-startup;1']
				.getService(Components.interfaces.nsIAppStartup)
				.quit(Components.interfaces.nsIAppStartup.eForceQuit);
		}, 250);
	}
}

function Reporter(runner) {
	var indents = 0, passed = 0, failed = 0, aborted = false;

	function indent() {
		return Array(indents).join('  ');
	}

	runner.on('start', function(){});

	runner.on('suite', function(suite){
		++indents;
		dump(indent()+suite.title+"\n");
	});

	runner.on('suite end', function(suite){
		--indents;
		if (1 == indents) dump("\n");
	});

	runner.on('pending', function(test){
		dump(indent()+"pending  -"+test.title);
	});

	runner.on('pass', function(test){
		passed++;
		var msg = "\r"+indent()+Mocha.reporters.Base.symbols.ok+" "+test.title;
		if ('fast' != test.speed) {
			msg += " ("+Math.round(test.duration)+" ms)";
		}
		dump(msg+"\n");
	});

	runner.on('fail', function(test, err){
		failed++;
		dump("\r" + indent()
			// Dark red X for errors
			+ "\033[31;40m" + Mocha.reporters.Base.symbols.err + "\033[0m"
			+ " " + test.title + "\n"
			+ indent() + "  " + err.toString() + " at\n"
			+ indent() + "    " + err.stack.replace("\n", "\n" + indent() + "    ", "g"));
		
		if (ZoteroUnit.bail) {
			aborted = true;
			runner.abort();
		}
	});

	runner.on('end', function() {
		dump(passed + "/" + (passed + failed) + " tests passed"
			+ (aborted ? " -- aborting" : "") + "\n");
		quit(failed != 0);
	});
}

// Setup Mocha
mocha.setup({
	ui: "bdd",
	reporter: Reporter,
	timeout: 5000,
	grep: ZoteroUnit.grep
});

// Enable Bluebird generator support in Mocha
(function () {
	var Runnable = Mocha.Runnable;
	var run = Runnable.prototype.run;
	Runnable.prototype.run = function (fn) {
		if (this.fn.constructor.name === 'GeneratorFunction') {
			this.fn = Zotero.Promise.coroutine(this.fn);
		}
		return run.call(this, fn);
	};
})();

var assert = chai.assert,
    expect = chai.expect;

// Set up tests to run
var run = true;
if(ZoteroUnit.tests) {
	var testDirectory = getTestDataDirectory().parent,
	    testFiles = [];
	if(ZoteroUnit.tests == "all") {
		var enumerator = testDirectory.directoryEntries;
		while(enumerator.hasMoreElements()) {
			var file = enumerator.getNext().QueryInterface(Components.interfaces.nsIFile);
			if(file.leafName.endsWith(".js")) {
				testFiles.push(file.leafName);
			}
		}
	} else {
		var specifiedTests = ZoteroUnit.tests.split(",");
		for (let test of specifiedTests) {
			// Allow foo, fooTest, fooTest.js, and tests/fooTest.js
			test = test.replace(/\.js$/, "");
			test = test.replace(/Test$/, "");
			test = test.replace(/^tests[/\\]/, "");
			let fname = test + "Test.js";
			let file = testDirectory.clone();
			file.append(fname);
			if (!file.exists()) {
				dump("Invalid test file "+test+"\n");
				run = false;
				quit(true);
			}
			testFiles.push(fname);
		}
	}

	for(var fname of testFiles) {
		var el = document.createElement("script");
		el.type = "application/javascript;version=1.8";
		el.src = "resource://zotero-unit-tests/"+fname;
		document.body.appendChild(el);
	}
}

if(run) {
	window.onload = function() {
		Zotero.spawn(function* () {
			yield Zotero.Schema.schemaUpdatePromise;
			
			// Download and cache PDF tools for this platform
			//
			// To reset, delete test/tests/data/pdf/ directory
			var cachePDFTools = Zotero.Promise.coroutine(function* () {
				Components.utils.import("resource://zotero/config.js");
				var baseURL = ZOTERO_CONFIG.PDF_TOOLS_URL;
				
				var path = OS.Path.join(getTestDataDirectory().path, 'pdf');
				yield OS.File.makeDir(path, { ignoreExisting: true });
				
				// Get latest tools version for the current platform
				var latestPath = OS.Path.join(path, "latest.json");
				var xmlhttp = yield Zotero.HTTP.request("GET", baseURL + "latest.json");
				var json = xmlhttp.responseText;
				yield Zotero.File.putContentsAsync(latestPath, json);
				json = JSON.parse(json);
				
				var platform = Zotero.platform.replace(/\s/g, '-');
				var version = json[platform] || json['default'];
				
				// Create version directory (e.g., data/pdf/3.04) and download tools to it if
				// they don't exist
				yield OS.File.makeDir(OS.Path.join(path, version), { ignoreExisting: true });
				
				var fileName = "pdfinfo-" + platform + (Zotero.isWin ? ".exe" : "");
				var execPath = OS.Path.join(path, version, fileName);
				if (!(yield OS.File.exists(execPath))) {
					yield Zotero.File.download(baseURL + version + "/" + fileName, execPath);
				}
				fileName = "pdftotext-" + platform;
				execPath = OS.Path.join(path, version, fileName);
				if (!(yield OS.File.exists(execPath))) {
					yield Zotero.File.download(baseURL + version + "/" + fileName, execPath);
				}
				
				// Point full-text code to the cache directory, so downloads come from there
				Zotero.Fulltext.pdfToolsDownloadBaseURL = OS.Path.toFileURI(path) + "/";
			});
			
			try {
				yield cachePDFTools();
			}
			catch (e) {
				Zotero.logError(e);
			}
			
			return mocha.run();
		})
	};
}