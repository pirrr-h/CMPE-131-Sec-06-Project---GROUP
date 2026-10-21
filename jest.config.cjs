module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/shared', '<rootDir>/tests'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: { module: 'commonjs', esModuleInterop: true, types: ['jest'] } }],
  },
};