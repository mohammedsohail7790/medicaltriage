/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest/presets/default-esm",
  testEnvironment: "jsdom",
  // lucide-react (bumped for the React 19 migration) now ships a package.json
  // "exports" map with separate "import"/"require" conditions - without this,
  // Jest's resolver picks the raw-ESM "import" build even though this whole
  // suite runs under CommonJS, causing "Cannot use import statement outside
  // a module". Force the "require"/"node" conditions so the CJS build resolves.
  testEnvironmentOptions: {
    customExportConditions: ["node", "require"]
  },
  testMatch: ["<rootDir>/frontend/src/**/*.test.ts", "<rootDir>/frontend/src/**/*.test.tsx"],
  setupFilesAfterEnv: ["<rootDir>/frontend/test/jest.setup.ts"],
  extensionsToTreatAsEsm: [".ts", ".tsx"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
    "\\.css$": "<rootDir>/frontend/test/styleMock.cjs"
  },
  // jose (used to encrypt the sign-in form) ships ESM only; transform it the way the backend config does.
  transformIgnorePatterns: ["node_modules/(?!.*(jose))"],
  transform: {
    "^.+\\.jsx?$": "babel-jest",
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        tsconfig: "tsconfig.frontend.test.json",
        useESM: true
      }
    ]
  }
};
