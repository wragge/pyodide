const chai = require("chai");

describe("Pyodide", () => {
  it("runPython", async () => {
    const factory = async () => {
      return pyodide.runPython("1+1");
    };
    const result = await chai.assert.isFulfilled(page.evaluate(factory));
    chai.assert.equal(result, 2);
  });
  describe("micropip", () => {
    before(async () => {
      const factory = async () => {
        await pyodide.loadPackage(["micropip"]);
      };
      await chai.assert.isFulfilled(page.evaluate(factory));
    });

    it("install", async () => {
      const factory = async () => {
        await pyodide.runPythonAsync(
          'import micropip; await micropip.install("snowballstemmer")',
        );
        return pyodide.runPython(`
          import snowballstemmer
          len(snowballstemmer.stemmer('english').stemWords(['A', 'node', 'test']))
        `);
      };
      const result = await chai.assert.isFulfilled(page.evaluate(factory));
      chai.assert.equal(result, 3);
    });
  });
});
