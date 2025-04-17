import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Calculator } from '../src/calculator.js';

describe('Calculator', () => {
  it('should add two numbers correctly', () => {
    const calc = new Calculator();
    assert.strictEqual(calc.add(2, 3), 5);
  });
  
  it('should subtract two numbers correctly', () => {
    const calc = new Calculator();
    assert.strictEqual(calc.subtract(5, 3), 2);
  });
  
  it('should multiply two numbers correctly', () => {
    const calc = new Calculator();
    assert.strictEqual(calc.multiply(2, 3), 6);
  });
  
  it('should divide two numbers correctly', () => {
    const calc = new Calculator();
    assert.strictEqual(calc.divide(6, 3), 2);
  });
  
  it('should throw error when dividing by zero', () => {
    const calc = new Calculator();
    assert.throws(() => calc.divide(1, 0), {
      message: 'Division by zero'
    });
  });
});