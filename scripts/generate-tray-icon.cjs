// Generate a simple envelope tray icon for macOS
// This creates a 22x22 PNG template image

const fs = require('fs');
const path = require('path');

// Simple 22x22 envelope icon as base64 PNG (black on transparent)
// This is a minimal envelope shape suitable for macOS menu bar
const envelopeIconBase64 =
  'iVBORw0KGgoAAAANSUhEUgAAABYAAAAWCAYAAADEtGw7AAAABHNCSVQICAgIfAhkiAAAAAlwSFlz' +
  'AAAOxAAADsQBlSsOGwAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAADCSURB' +
  'VDiN7ZQxDoJAEEX/LCRewsLGxsrCeAJP4AVsPIGNhYW1J/AINhYWcoUt7CxoiLUJBIMBVqP+ZJJp' +
  'Jm/+zswuMAH8cPBrRmZ2IqsJfhd4MwO/Cqx6wN8oBhgAZ/vfABb2vdBaax4EB1jnf+xW4C2wMLdq' +
  'rT0CJ+AWOJlZbTuq1QGPwBrYA1PAzWxhZm0dYICbmXVkZhWgaAPf0i9m9hQRlvpI4H5b/PwFr4i0' +
  'BEw+CnwB9oB7M+umBrAGnPrg/0kv95xLm/jHGFcAAAAASUVORK5CYII=';

// Higher resolution version for retina (44x44)
const envelopeIcon2xBase64 =
  'iVBORw0KGgoAAAANSUhEUgAAACwAAAAsCAYAAAAehFoBAAAABHNCSVQICAgIfAhkiAAAAAlwSFlz' +
  'AAAbrwAAG68BXhqRHAAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAAFNSURB' +
  'VFiF7ZixSgNBEIb/WSMpgoWFjYWVhQ9g4wNY+AI2PoGNhYUv4ANYWFhY+QS2FhYiiIWNWFhoYSME' +
  'C8EiEIgmuJ7rxrtzs+f9MLBwO/vtzM7dHjADfHPwbYbH5OigGPg14LcB/wqs+sC/KQaYAKf9bwEW' +
  '9t1prVXywADX+R+7BXgDLI2tUkvPwAlwB5wn5pYJVauACzyBNbAHJoGr0dJWLWCAq5F5RESGtfBN' +
  '/WJkD4rI0zhir+lnI3vyLX75BV8TaQGY+izwFdgH7kZLW8WAFeCsD/6X9LORPRsQFulIYH5d/PwB' +
  't0TagpJPC58PvI0EJIjIOzAf+XoFhoDLo4i8AoPAfN8lYQCYi8h5H9iG6hcHlCJyZozJA6dEpBIR' +
  'PwSO+8K2xJIu4AD4EJExAYmIFBHxk/AO8CYi9xJ6BVgGXvrA/0k/AHeTRs+8yVVDAAAAAElFTkSu' +
  'QmCC';

const iconsDir = path.join(__dirname, '..', 'src-tauri', 'icons');

// Write the tray icon
fs.writeFileSync(
  path.join(iconsDir, 'tray-icon.png'),
  Buffer.from(envelopeIconBase64, 'base64')
);

// Write the 2x version for retina
fs.writeFileSync(
  path.join(iconsDir, 'tray-icon@2x.png'),
  Buffer.from(envelopeIcon2xBase64, 'base64')
);

console.log('Tray icons generated successfully!');
console.log('  - tray-icon.png (22x22)');
console.log('  - tray-icon@2x.png (44x44)');
