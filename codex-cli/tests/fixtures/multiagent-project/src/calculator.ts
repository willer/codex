/**
 * A simple calculator class with basic operations
 */
export class Calculator {
  /**
   * Add two numbers
   */
  add(a: number, b: number): number {
    return a + b;
  }
  
  /**
   * Subtract b from a
   */
  subtract(a: number, b: number): number {
    return a - b;
  }
  
  /**
   * Multiply two numbers
   */
  multiply(a: number, b: number): number {
    return a * b;
  }
  
  /**
   * Divide a by b
   * @throws {Error} When dividing by zero
   */
  divide(a: number, b: number): number {
    if (b === 0) {
      throw new Error("Division by zero");
    }
    return a / b;
  }
}