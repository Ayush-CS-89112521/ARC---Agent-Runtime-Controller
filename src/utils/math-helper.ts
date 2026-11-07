/**
 * Math Helper Utilities - INTENTIONALLY BROKEN FOR E2E TEST
 * This file contains functions with poor error handling
 * Used to test the Agent Runtime Controller's refactoring workflow
 */

/**
 * Calculate the square root of a number
 * ISSUE: No input validation, no error handling for negative numbers
 */
export function calculateSquareRoot(num: number): number {
  return Math.sqrt(num);
}

/**
 * Divide two numbers
 * ISSUE: No division by zero check, no error handling
 */
export function divideNumbers(numerator: number, denominator: number): number {
  return numerator / denominator;
}

/**
 * Parse JSON string to object
 * ISSUE: No try-catch, will crash on invalid JSON
 */
export function parseJsonData(jsonString: string): Record<string, unknown> {
  return JSON.parse(jsonString);
}

/**
 * Fetch data from a URL
 * ISSUE: No error handling for network failures
 */
export async function fetchFromUrl(url: string): Promise<Response> {
  return fetch(url);
}

/**
 * Calculate average of array
 * ISSUE: No empty array check, no type validation
 */
export function calculateAverage(numbers: number[]): number {
  const sum = numbers.reduce((a, b) => a + b, 0);
  return sum / numbers.length;
}

/**
 * Find max value in array
 * ISSUE: No empty array check, no null handling
 */
export function findMaxValue(numbers: number[]): number {
  let max = numbers[0];
  for (let i = 1; i < numbers.length; i++) {
    if (numbers[i] > max) {
      max = numbers[i];
    }
  }
  return max;
}

/**
 * Format currency value
 * ISSUE: No negative value handling, no currency validation
 */
export function formatCurrency(amount: number, currency: string): string {
  return `${currency} ${amount.toFixed(2)}`;
}

/**
 * Deep clone an object
 * ISSUE: No circular reference handling, no error handling
 */
export function deepClone(obj: any): any {
  return JSON.parse(JSON.stringify(obj));
}
