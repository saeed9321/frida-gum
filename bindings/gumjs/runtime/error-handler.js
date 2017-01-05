'use strict';

module.exports = {
  register: register
};

function register() {
  const engine = global;

  const runtime = Script.runtime;
  if (runtime === 'V8') {
    engine._setUnhandledExceptionCallback(function (error) {
      const message = {
        type: 'error',
        description: '' + error
      };

      if (error instanceof Error) {
        const stack = error.stack;
        if (stack) {
          message.stack = stack;

          const frames = stack.frames;
          if (frames) {
            const frame = frames[0];
            message.fileName = frame.getFileName();
            message.lineNumber = frame.getLineNumber();
            message.columnNumber = frame.getColumnNumber();
          }
        }
      }

      engine._send(JSON.stringify(message), null);
    });

    Error.prepareStackTrace = function (error, stack) {
      const translatedStack = stack.map(function (frame) {
        return wrapCallSite(frame);
      });
      if (translatedStack[0].toString() === 'Error (native)')
        translatedStack.splice(0, 1);
      const result = new String(error.toString() + translatedStack.map(function (frame) {
        return '\n    at ' + frame.toString();
      }).join(''));
      result.frames = translatedStack;
      return result;
    };
  } else if (runtime === 'DUK') {
    engine._setUnhandledExceptionCallback(function (error) {
      const message = {
        type: 'error',
        description: '' + error
      };

      if (error instanceof Error) {
        const stack = error.stack;
        if (stack) {
          message.stack = stack;
        }

        const fileName = error.fileName;
        if (fileName) {
          message.fileName = fileName;
        }

        const lineNumber = error.lineNumber;
        if (lineNumber) {
          message.lineNumber = lineNumber;
          message.columnNumber = 1;
        }
      }

      engine._send(JSON.stringify(message), null);
    });

    Duktape.errCreate = function (error) {
      let stack = error.stack;
      if (!stack)
        return error;

      let firstSourcePosition = null;
      let frameTypes = [];

      stack = stack
          .replace(/    at (.+) \(((.+):(.+))?\) (internal)?(native)?(.*)/g,
            function (match, scope, sourceLocation, fileName, lineNumber, internal, native, suffix) {
              frameTypes.push(internal || native);

              if (sourceLocation === undefined || internal !== undefined) {
                return '    at ' + scope + ' (' + (sourceLocation || (native || "")) + ')';
              }

              const position = mapSourcePosition({
                source: fileName,
                line: parseInt(lineNumber, 10),
                column: 0
              });

              if (firstSourcePosition === null)
                firstSourcePosition = position;

              const location = position.source + ':' + position.line;

              const funcName = (scope !== 'global' && scope !== '[anon]') ? scope : null;
              if (funcName !== null)
                return '    at ' + funcName + ' (' + location + ')';
              else
                return '    at ' + location;
            });

      if (frameTypes.length >= 3 && frameTypes[0] === 'internal' && frameTypes[1] === 'native') {
        const lines = stack.split('\n');
        stack = lines[0] + '\n' + lines.slice(3).join('\n');
      }

      error.stack = stack;

      if (firstSourcePosition !== null) {
        error.fileName = firstSourcePosition.source;
        error.lineNumber = firstSourcePosition.line;
      }

      return error;
    };
  }
}

/*
 * Based on https://github.com/evanw/node-source-map-support
 */

const sourceMapCache = {};
function wrapCallSite(frame) {
  // Most call sites will return the source file from getFileName(), but code
  // passed to eval() ending in "//# sourceURL=..." will return the source file
  // from getScriptNameOrSourceURL() instead
  const source = frame.getFileName() || frame.getScriptNameOrSourceURL();
  if (source) {
    const line = frame.getLineNumber();
    const column = frame.getColumnNumber() - 1;

    const position = mapSourcePosition({
      source: source,
      line: line,
      column: column
    });
    frame = cloneCallSite(frame);
    frame.getFileName = function () {
      return position.source;
    };
    frame.getLineNumber = function () {
      return position.line;
    };
    frame.getColumnNumber = function () {
      return position.column + 1;
    };
    frame.getScriptNameOrSourceURL = function () {
      return position.source;
    };
    return frame;
  }

  // Code called using eval() needs special handling
  let origin = frame.isEval() && frame.getEvalOrigin();
  if (origin) {
    origin = mapEvalOrigin(origin);
    frame = cloneCallSite(frame);
    frame.getEvalOrigin = function () {
      return origin;
    };
    return frame;
  }

  // If we get here then we were unable to change the source position
  return frame;
}

function mapSourcePosition(position) {
  let item = sourceMapCache[position.source];
  if (!item) {
    item = sourceMapCache[position.source] = {
      map: findSourceMap(position.source)
    };
  }

  if (item.map) {
    const originalPosition = item.map.resolve(position);

    // Only return the original position if a matching line was found. If no
    // matching line is found then we return position instead, which will cause
    // the stack trace to print the path and line for the compiled file. It is
    // better to give a precise location in the compiled file than a vague
    // location in the original file.
    if (originalPosition !== null)
      return originalPosition;
  }

  return position;
}

// Parses code generated by FormatEvalOrigin(), a function inside V8:
// https://code.google.com/p/v8/source/browse/trunk/src/messages.js
function mapEvalOrigin(origin) {
  // Most eval() calls are in this format
  let match = /^eval at ([^(]+) \((.+):(\d+):(\d+)\)$/.exec(origin);
  if (match) {
    const position = mapSourcePosition({
      source: match[2],
      line: parseInt(match[3], 10),
      column: parseInt(match[4], 10) - 1
    });
    return 'eval at ' + match[1] + ' (' + position.source + ':' + position.line + ':' + (position.column + 1) + ')';
  }

  // Parse nested eval() calls using recursion
  match = /^eval at ([^(]+) \((.+)\)$/.exec(origin);
  if (match) {
    return 'eval at ' + match[1] + ' (' + mapEvalOrigin(match[2]) + ')';
  }

  // Make sure we still return useful information if we didn't find anything
  return origin;
}

function findSourceMap(source) {
  if (source === Script.fileName)
    return Script.sourceMap;
  else if (source === 'frida.js')
    return Frida.sourceMap;
  else if (source === 'objc.js')
    return Frida._objcSourceMap;
  else if (source === 'java.js')
    return Frida._javaSourceMap;
  else
    return null;
}

function cloneCallSite(frame) {
  const object = {};
  Object.getOwnPropertyNames(Object.getPrototypeOf(frame)).forEach(function (name) {
    object[name] = /^(?:is|get)/.test(name)
        ? function () { return frame[name].call(frame); }
        : frame[name];
  });
  object.toString = CallSiteToString;
  return object;
}

// This is copied almost verbatim from the V8 source code at
// https://code.google.com/p/v8/source/browse/trunk/src/messages.js. The
// implementation of wrapCallSite() used to just forward to the actual source
// code of CallSite.prototype.toString but unfortunately a new release of V8
// did something to the prototype chain and broke the shim. The only fix I
// could find was copy/paste.
function CallSiteToString() {
  let fileLocation = '';
  if (this.isNative()) {
    fileLocation = 'native';
  } else {
    const fileName = this.getScriptNameOrSourceURL();
    if (!fileName && this.isEval()) {
      fileLocation = this.getEvalOrigin();
      fileLocation += ', '; // Expecting source position to follow.
    }

    if (fileName) {
      fileLocation += fileName;
    } else {
      // Source code does not originate from a file and is not native, but we
      // can still get the source position inside the source string, e.g. in
      // an eval string.
      fileLocation += '<anonymous>';
    }
    const lineNumber = this.getLineNumber();
    if (lineNumber !== null) {
      fileLocation += ':' + lineNumber;
      const columnNumber = this.getColumnNumber();
      if (columnNumber)
        fileLocation += ':' + columnNumber;
    }
  }

  let line = '';
  const functionName = this.getFunctionName();
  let addSuffix = true;
  const isConstructor = this.isConstructor();
  const isMethodCall = !(this.isToplevel() || isConstructor);
  if (isMethodCall) {
    let typeName;
    try {
      typeName = this.getTypeName();
    } catch (e) {
      typeName = 'Proxy';
    }
    const methodName = this.getMethodName();
    if (functionName) {
      if (typeName && functionName.indexOf(typeName) != 0) {
        line += typeName + '.';
      }
      line += functionName;
      if (methodName && functionName.indexOf('.' + methodName) != functionName.length - methodName.length - 1) {
        line += ' [as ' + methodName + ']';
      }
    } else {
      line += typeName + '.' + (methodName || '<anonymous>');
    }
  } else if (isConstructor) {
    line += 'new ' + (functionName || '<anonymous>');
  } else if (functionName) {
    line += functionName;
  } else {
    line += fileLocation;
    addSuffix = false;
  }
  if (addSuffix) {
    line += ' (' + fileLocation + ')';
  }
  return line;
}
