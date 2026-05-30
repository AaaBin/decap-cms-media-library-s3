const path = require('path');
const pkg = require('./package.json');
const isProduction = process.env.NODE_ENV === 'production';

const libraryName = pkg.name
  .split(/[-/]/)
  .map(part => part.charAt(0).toUpperCase() + part.slice(1))
  .join('');

module.exports = {
  context: __dirname,
  mode: isProduction ? 'production' : 'development',
  entry: './src',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: `${pkg.name}.js`,
    library: libraryName,
    libraryTarget: 'umd',
    libraryExport: libraryName,
    umdNamedDefine: true,
    globalObject: 'window',
  },
  module: {
    rules: [
      {
        test: /\.js$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',
        },
      },
    ],
  },
  resolve: {
    extensions: ['.js', '.json'],
  },
  devtool: isProduction ? 'source-map' : false,
  target: 'web',
};
