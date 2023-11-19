module.exports = {
    "root": true,
    "parser": "@typescript-eslint/parser",
    "parserOptions": {
        "project": `./tsconfig.json`
    },
    "plugins": [
        "@typescript-eslint"
    ],
    "extends": [
        "eslint:recommended",
        "plugin:@typescript-eslint/eslint-recommended",
        "plugin:@typescript-eslint/recommended"
    ],
    "rules": {
        "@typescript-eslint/no-unused-vars": ["error", {"varsIgnorePattern": "^_", "argsIgnorePattern": "^_"}],
        "@typescript-eslint/naming-convention": ["error", {
            "format": ["camelCase", "UPPER_CASE", "PascalCase"],
            "selector": "variable",
            "leadingUnderscore": 'allow',
            'trailingUnderscore': 'allow'
        }],
        "@typescript-eslint/explicit-module-boundary-types": "error",
        "@typescript-eslint/no-require-imports": "error",
        "@typescript-eslint/prefer-nullish-coalescing": "error",
        "@typescript-eslint/prefer-optional-chain": "error",
        "@typescript-eslint/prefer-string-starts-ends-with": "error",
        "@typescript-eslint/promise-function-async": "error",
        "@typescript-eslint/switch-exhaustiveness-check": "error",
        "@typescript-eslint/type-annotation-spacing": "error"
    }
};