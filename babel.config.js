const isESM = process.env.NODE_ENV === 'esm';

module.exports = {
  presets: [
    ...(!isESM ? [['@babel/preset-env', { targets: 'last 2 Chrome versions, last 2 Firefox versions' }]] : []),
  ],
};
