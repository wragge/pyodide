/**
 * The main bootstrap code for loading pyodide.
 */
import ErrorStackParser from "error-stack-parser";
import { loadScript, initNodeModules, pathSep, resolvePath } from "./compat";

import { createModule, initializeFileSystem } from "./module";
import { version } from "./version";

import type { PyodideInterface } from "./api.js";
import type { PyProxy, PyDict } from "./pyproxy.gen";
export type { PyodideInterface };

export type {
  PyProxy,
  PyProxyWithLength,
  PyProxyWithGet,
  PyProxyWithSet,
  PyProxyWithHas,
  PyProxyDict,
  PyProxyIterable,
  PyProxyIterator,
  PyProxyAwaitable,
  PyProxyCallable,
  TypedArray,
  PyBuffer as PyProxyBuffer,
  PyBufferView as PyBuffer,
} from "./pyproxy.gen";

export type Py2JsResult = any;

export { version };

/**
 * A proxy around globals that falls back to checking for a builtin if has or
 * get fails to find a global with the given key. Note that this proxy is
 * transparent to js2python: it won't notice that this wrapper exists at all and
 * will translate this proxy to the globals dictionary.
 * @private
 */
function wrapPythonGlobals(globals_dict: PyDict, builtins_dict: PyDict) {
  return new Proxy(globals_dict, {
    get(target, symbol) {
      if (symbol === "get") {
        return (key: any) => {
          let result = target.get(key);
          if (result === undefined) {
            result = builtins_dict.get(key);
          }
          return result;
        };
      }
      if (symbol === "has") {
        return (key: any) => target.has(key) || builtins_dict.has(key);
      }
      return Reflect.get(target, symbol);
    },
  });
}

/**
 * This function is called after the emscripten module is finished initializing,
 * so eval_code is newly available.
 * It finishes the bootstrap so that once it is complete, it is possible to use
 * the core `pyodide` apis. (But package loading is not ready quite yet.)
 * @private
 */
function finalizeBootstrap(API: any, config: ConfigType) {
  // First make internal dict so that we can use runPythonInternal.
  // runPythonInternal uses a separate namespace, so we don't pollute the main
  // environment with variables from our setup.
  API.runPythonInternal_dict = API._pyodide._base.eval_code("{}") as PyProxy;
  API.importlib = API.runPythonInternal("import importlib; importlib");
  let import_module = API.importlib.import_module;

  API.sys = import_module("sys");
  API.sys.path.insert(0, config.env.HOME);
  API.os = import_module("os");

  // Set up globals
  let globals = API.runPythonInternal(
    "import __main__; __main__.__dict__",
  ) as PyDict;
  let builtins = API.runPythonInternal(
    "import builtins; builtins.__dict__",
  ) as PyDict;
  API.globals = wrapPythonGlobals(globals, builtins);

  // Set up key Javascript modules.
  let importhook = API._pyodide._importhook;
  function jsFinderHook(o: object) {
    if ("__all__" in o) {
      return;
    }
    Object.defineProperty(o, "__all__", {
      get: () =>
        pyodide.toPy(
          Object.getOwnPropertyNames(o).filter((name) => name !== "__all__"),
        ),
      enumerable: false,
      configurable: true,
    });
  }
  importhook.register_js_finder.callKwargs({ hook: jsFinderHook });
  importhook.register_js_module("js", config.jsglobals);

  let pyodide = API.makePublicAPI();
  importhook.register_js_module("pyodide_js", pyodide);

  // import pyodide_py. We want to ensure that as much stuff as possible is
  // already set up before importing pyodide_py to simplify development of
  // pyodide_py code (Otherwise it's very hard to keep track of which things
  // aren't set up yet.)
  API.pyodide_py = import_module("pyodide");
  API.pyodide_code = import_module("pyodide.code");
  API.pyodide_ffi = import_module("pyodide.ffi");
  API.package_loader = import_module("pyodide._package_loader");

  API.sitepackages = API.package_loader.SITE_PACKAGES.__str__();
  API.dsodir = API.package_loader.DSO_DIR.__str__();
  API.defaultLdLibraryPath = [API.dsodir, API.sitepackages];

  API.os.environ.__setitem__(
    "LD_LIBRARY_PATH",
    API.defaultLdLibraryPath.join(":"),
  );

  // copy some last constants onto public API.
  pyodide.pyodide_py = API.pyodide_py;
  pyodide.globals = API.globals;
  return pyodide;
}

declare function _createPyodideModule(Module: any): Promise<void>;

/**
 *  If indexURL isn't provided, throw an error and catch it and then parse our
 *  file name out from the stack trace.
 *
 *  Question: But getting the URL from error stack trace is well... really
 *  hacky. Can't we use
 *  [`document.currentScript`](https://developer.mozilla.org/en-US/docs/Web/API/Document/currentScript)
 *  or
 *  [`import.meta.url`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/import.meta)
 *  instead?
 *
 *  Answer: `document.currentScript` works for the browser main thread.
 *  `import.meta` works for es6 modules. In a classic webworker, I think there
 *  is no approach that works. Also we would need some third approach for node
 *  when loading a commonjs module using `require`. On the other hand, this
 *  stack trace approach works for every case without any feature detection
 *  code.
 */
function calculateIndexURL(): string {
  if (typeof __dirname === "string") {
    return __dirname;
  }
  let err: Error;
  try {
    throw new Error();
  } catch (e) {
    err = e as Error;
  }
  let fileName = ErrorStackParser.parse(err)[0].fileName!;
  const indexOfLastSlash = fileName.lastIndexOf(pathSep);
  if (indexOfLastSlash === -1) {
    throw new Error(
      "Could not extract indexURL path from pyodide module location",
    );
  }
  return fileName.slice(0, indexOfLastSlash);
}

/**
 * See documentation for loadPyodide.
 * @private
 */
export type ConfigType = {
  indexURL: string;
  lockFileURL: string;
  homedir: string;
  fullStdLib?: boolean;
  stdLibURL?: string;
  stdin?: () => string;
  stdout?: (msg: string) => void;
  stderr?: (msg: string) => void;
  jsglobals?: object;
  args: string[];
  _node_mounts: string[];
  env: { [key: string]: string };
};

/**
 * Load the main Pyodide wasm module and initialize it.
 *
 * @returns The :ref:`js-api-pyodide` module.
 * @memberof globalThis
 * @async
 */
export async function loadPyodide(
  options: {
    /**
     * The URL from which Pyodide will load the main Pyodide runtime and
     * packages. It is recommended that you leave this unchanged, providing an
     * incorrect value can cause broken behavior.
     *
     * Default: The url that Pyodide is loaded from with the file name
     * (``pyodide.js`` or ``pyodide.mjs``) removed.
     */
    indexURL?: string;

    /**
     * The URL from which Pyodide will load the Pyodide ``repodata.json`` lock
     * file. You can produce custom lock files with :py:func:`micropip.freeze`.
     * Default: ```${indexURL}/repodata.json```
     */
    lockFileURL?: string;

    /**
     * The home directory which Pyodide will use inside virtual file system.
     * This is deprecated, use ``{env: {HOME : some_dir}}`` instead.
     */
    homedir?: string;
    /**
     * Load the full Python standard library. Setting this to false excludes
     * unvendored modules from the standard library.
     * Default: ``false``
     */
    fullStdLib?: boolean;
    /**
     * The URL from which to load the standard library ``python_stdlib.zip``
     * file. This URL includes the most of the Python stadard library. Some
     * stdlib modules were unvendored, and can be loaded separately
     * with ``fullStdLib=true`` option or by their package name.
     * Default: ```${indexURL}/python_stdlib.zip```
     */
    stdLibURL?: string;
    /**
     * Override the standard input callback. Should ask the user for one line of
     * input.
     */
    stdin?: () => string;
    /**
     * Override the standard output callback.
     */
    stdout?: (msg: string) => void;
    /**
     * Override the standard error output callback.
     */
    stderr?: (msg: string) => void;
    /**
     * The object that Pyodide will use for the ``js`` module.
     * Default: ``globalThis``
     */
    jsglobals?: object;
    /**
     * Command line arguments to pass to Python on startup. See `Python command
     * line interface options
     * <https://docs.python.org/3.10/using/cmdline.html#interface-options>`_ for
     * more details. Default: ``[]``
     */
    args?: string[];
    /**
     * Environment variables to pass to Python. This can be accessed inside of
     * Python at runtime via `os.environ`. Certain environment variables change
     * the way that Python loads:
     * https://docs.python.org/3.10/using/cmdline.html#environment-variables
     * Default: {}
     * If `env.HOME` is undefined, it will be set to a default value of
     * `"/home/pyodide"`
     */
    env?: { [key: string]: string };

    /**
     * @ignore
     */
    _node_mounts?: string[];
  } = {},
): Promise<PyodideInterface> {
  await initNodeModules();
  let indexURL = options.indexURL || calculateIndexURL();
  indexURL = resolvePath(indexURL); // A relative indexURL causes havoc.
  if (!indexURL.endsWith("/")) {
    indexURL += "/";
  }
  options.indexURL = indexURL;

  const default_config = {
    fullStdLib: false,
    jsglobals: globalThis,
    stdin: globalThis.prompt ? globalThis.prompt : undefined,
    lockFileURL: indexURL! + "repodata.json",
    args: [],
    _node_mounts: [],
    env: {},
  };
  const config = Object.assign(default_config, options) as ConfigType;
  if (options.homedir) {
    console.warn(
      "The homedir argument to loadPyodide is deprecated. " +
        "Use 'env: { HOME: value }' instead of 'homedir: value'.",
    );
    if (options.env && options.env.HOME) {
      throw new Error("Set both env.HOME and homedir arguments");
    }
    config.env.HOME = config.homedir;
  }
  if (!config.env.HOME) {
    config.env.HOME = "/home/pyodide";
  }

  const Module = createModule();
  Module.print = config.stdout;
  Module.printErr = config.stderr;
  Module.arguments = config.args;
  const API: any = { config };
  Module.API = API;

  initializeFileSystem(Module, config);

  const moduleLoaded = new Promise((r) => (Module.postRun = r));

  // locateFile tells Emscripten where to find the data files that initialize
  // the file system.
  Module.locateFile = (path: string) => config.indexURL + path;

  // If the pyodide.asm.js script has been imported, we can skip the dynamic import
  // Users can then do a static import of the script in environments where
  // dynamic importing is not allowed or not desirable, like module-type service workers
  if (typeof _createPyodideModule !== "function") {
    const scriptSrc = `${config.indexURL}pyodide.asm.js`;
    await loadScript(scriptSrc);
  }

  // _createPyodideModule is specified in the Makefile by the linker flag:
  // `-s EXPORT_NAME="'_createPyodideModule'"`
  await _createPyodideModule(Module);

  // There is some work to be done between the module being "ready" and postRun
  // being called.
  await moduleLoaded;
  // Handle early exit
  if (Module.exited) {
    throw Module.exited.toThrow;
  }

  if (API.version !== version) {
    throw new Error(
      `\
Pyodide version does not match: '${version}' <==> '${API.version}'. \
If you updated the Pyodide version, make sure you also updated the 'indexURL' parameter passed to loadPyodide.\
`,
    );
  }
  // Disable further loading of Emscripten file_packager stuff.
  Module.locateFile = (path: string) => {
    throw new Error("Didn't expect to load any more file_packager files!");
  };

  let [err, captured_stderr] = API.rawRun("import _pyodide_core");
  if (err) {
    Module.API.fatal_loading_error(
      "Failed to import _pyodide_core\n",
      captured_stderr,
    );
  }

  const pyodide = finalizeBootstrap(API, config);

  // runPython works starting here.
  if (!pyodide.version.includes("dev")) {
    // Currently only used in Node to download packages the first time they are
    // loaded. But in other cases it's harmless.
    API.setCdnUrl(`https://cdn.jsdelivr.net/pyodide/v${pyodide.version}/full/`);
  }
  await API.packageIndexReady;

  let importhook = API._pyodide._importhook;
  importhook.register_module_not_found_hook(
    API._import_name_to_package_name,
    API.repodata_unvendored_stdlibs_and_test,
  );

  if (API.repodata_info.version !== version) {
    throw new Error("Lock file version doesn't match Pyodide version");
  }
  API.package_loader.init_loaded_packages();
  if (config.fullStdLib) {
    await pyodide.loadPackage(API.repodata_unvendored_stdlibs);
  }
  API.initializeStreams(config.stdin, config.stdout, config.stderr);
  return pyodide;
}
