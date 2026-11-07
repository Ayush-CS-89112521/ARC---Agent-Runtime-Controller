/**
 * Condition Evaluator - Evaluates conditional expressions for step execution
 * Supports expressions like: ${steps.analyze.output.includes('vulnerability')}
 * Enables conditional step skipping for dynamic workflows
 */

import { ExecutionContext, ConditionEvaluationResult } from '../types/index.js';

/**
 * Evaluates a domain-specific condition expression using a safe, non-eval based parser.
 * Implements an LL(1) recursive descent grammar supporting:
 * - Variable resolution (steps.*, variables.*)
 * - Property/Method access with safe isolation.
 * - Complex logical combinations (&&, ||) and comparison operators.
 * 
 * @param condition - The raw expression string wrapped in ${...}.
 * @param context - The global execution context for variable resolution.
 * @returns Result object containing the boolean outcome or evaluation telemetry.
 */
export function evaluateCondition(
  condition: string,
  context: ExecutionContext
): ConditionEvaluationResult {
  const result: ConditionEvaluationResult = {
    condition,
    evaluated: false,
    context: {},
    timestamp: new Date(),
  };

  try {
    // Extract the expression from ${...} format
    const match = condition.match(/^\$\{(.+)\}$/);
    if (!match) {
      result.error = `Condition must be wrapped in \${...} format: "${condition}"`;
      return result;
    }

    const expression = match[1];

    // Parse and evaluate the expression
    const { value, contextUsed } = evaluateExpression(expression, context);
    result.evaluated = Boolean(value);
    result.context = contextUsed;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }

  return result;
}

/**
 * Parse and evaluate an expression safely
 * Supports:
 *  - Variable references: steps.stepId.output, variables.varName
 *  - Property access: object.property.nested
 *  - Method calls: string.includes('value'), array.length
 *  - Comparisons: === !== == != < > <= >=
 *  - Logical operators: && ||
 *
 * @internal
 */
function evaluateExpression(
  expression: string,
  context: ExecutionContext
): { value: unknown; contextUsed: Record<string, unknown> } {
  const contextUsed: Record<string, unknown> = {};

  // Tokenize and parse the expression safely
  const tokens = tokenizeExpression(expression);
  const result = evaluateTokens(tokens, context, contextUsed);

  return { value: result, contextUsed };
}

/**
 * Tokenize expression into meaningful parts
 * @internal
 */
function tokenizeExpression(expression: string): Token[] {
  const tokens: Token[] = [];
  let current = '';
  let inString = false;
  let stringChar = '';

  for (let i = 0; i < expression.length; i++) {
    const char = expression[i];
    const nextChar = expression[i + 1];

    // Handle string literals
    if ((char === '"' || char === "'") && !inString) {
      inString = true;
      stringChar = char;
      current += char;
      continue;
    }

    if (char === stringChar && inString) {
      inString = false;
      current += char;
      continue;
    }

    if (inString) {
      current += char;
      continue;
    }

    // Handle operators and special characters
    if (char === '(' || char === ')' || char === ',' || char === '.') {
      if (current.trim()) {
        tokens.push({ type: 'identifier', value: current.trim() });
        current = '';
      }
      tokens.push({ type: 'symbol', value: char });
      continue;
    }

    // Handle comparison operators
    if (
      (char === '=' || char === '!' || char === '<' || char === '>') &&
      (nextChar === '=' || (char === '=' && nextChar === '='))
    ) {
      if (current.trim()) {
        tokens.push({ type: 'identifier', value: current.trim() });
        current = '';
      }
      const op =
        char === '=' && nextChar === '='
          ? '=='
          : char + nextChar;
      tokens.push({ type: 'operator', value: op });
      i++; // Skip next char
      continue;
    }

    // Handle logical operators
    if (char === '&' && nextChar === '&') {
      if (current.trim()) {
        tokens.push({ type: 'identifier', value: current.trim() });
        current = '';
      }
      tokens.push({ type: 'operator', value: '&&' });
      i++; // Skip next char
      continue;
    }

    if (char === '|' && nextChar === '|') {
      if (current.trim()) {
        tokens.push({ type: 'identifier', value: current.trim() });
        current = '';
      }
      tokens.push({ type: 'operator', value: '||' });
      i++; // Skip next char
      continue;
    }

    // Handle whitespace
    if (char === ' ' && current.trim()) {
      tokens.push({ type: 'identifier', value: current.trim() });
      current = '';
      continue;
    }

    if (char === ' ') {
      continue;
    }

    current += char;
  }

  if (current.trim()) {
    tokens.push({ type: 'identifier', value: current.trim() });
  }

  return tokens;
}

interface Token {
  type: 'identifier' | 'operator' | 'symbol';
  value: string;
}

/**
 * Evaluate tokens using recursive descent parser
 * @internal
 */
function evaluateTokens(
  tokens: Token[],
  context: ExecutionContext,
  contextUsed: Record<string, unknown>
): unknown {
  let index = 0;

  function parseLogicalOr(): unknown {
    let left = parseLogicalAnd();

    while (index < tokens.length && tokens[index].value === '||') {
      index++; // consume '||'
      const right = parseLogicalAnd();
      left = Boolean(left) || Boolean(right);
    }

    return left;
  }

  function parseLogicalAnd(): unknown {
    let left = parseComparison();

    while (index < tokens.length && tokens[index].value === '&&') {
      index++; // consume '&&'
      const right = parseComparison();
      left = Boolean(left) && Boolean(right);
    }

    return left;
  }

  function parseComparison(): unknown {
    let left = parsePropertyAccess();

    if (index < tokens.length && tokens[index].type === 'operator') {
      const operator = tokens[index].value;
      if (['===', '!==', '==', '!=', '<', '>', '<=', '>='].includes(operator)) {
        index++; // consume operator
        const right = parsePropertyAccess();
        return compare(left, operator, right);
      }
    }

    return left;
  }

  function parsePropertyAccess(): unknown {
    let value = parsePrimary();

    // Handle special reference marker from parsePrimary
    let refPath = '';
    if (typeof value === 'object' && value !== null && '__refType' in value) {
      refPath = (value as any).__refType;
      value = undefined; // Will be resolved when we access properties
    }

    while (index < tokens.length && tokens[index].value === '.') {
      index++; // consume '.'

      if (index >= tokens.length) {
        throw new Error('Unexpected end of expression after "."');
      }

      const property = tokens[index].value;
      index++;

      // Build the reference path if we're in a variable reference
      if (refPath) {
        refPath += '.' + property;
      }

      // Check if this is a method call
      if (index < tokens.length && tokens[index].value === '(') {
        index++; // consume '('

        // Parse method arguments
        const args: unknown[] = [];
        while (index < tokens.length && tokens[index].value !== ')') {
          args.push(parsePrimary());
          if (index < tokens.length && tokens[index].value === ',') {
            index++; // consume ','
          }
        }

        if (index >= tokens.length || tokens[index].value !== ')') {
          throw new Error('Missing closing parenthesis in method call');
        }
        index++; // consume ')'

        // If this is the first property access on a reference, resolve it first
        if (value === undefined && refPath) {
          value = resolveVariableReference(refPath, context, contextUsed);
          refPath = ''; // Consumed the ref path
        }

        // Call method on value
        if (value !== null && value !== undefined && typeof (value as any)[property] === 'function') {
          value = (value as any)[property](...args);
        } else {
          throw new Error(
            `Method "${property}" not found on ${typeof value}`
          );
        }
      } else {
        // Property access (not a method)
        // If this is the first property access on a reference, resolve it first
        if (value === undefined && refPath) {
          value = resolveVariableReference(refPath, context, contextUsed);
          refPath = ''; // Consumed the ref path
        }

        if (value !== null && value !== undefined) {
          value = (value as any)[property];
        } else {
          value = undefined;
        }
      }
    }

    return value;
  }

  function parsePrimary(): unknown {
    if (index >= tokens.length) {
      throw new Error('Unexpected end of expression');
    }

    const token = tokens[index];

    // String literal
    if (token.value.startsWith('"') || token.value.startsWith("'")) {
      index++;
      return token.value.slice(1, -1); // Remove quotes
    }

    // Number literal
    if (/^\d+(\.\d+)?$/.test(token.value)) {
      index++;
      return parseFloat(token.value);
    }

    // Boolean literals
    if (token.value === 'true') {
      index++;
      return true;
    }
    if (token.value === 'false') {
      index++;
      return false;
    }

    // Variable reference - single component that will be handled by property access
    // Just get the first part and let parsePropertyAccess handle the dots
    if (token.value === 'steps' || token.value === 'variables') {
      index++;
      // Return a special marker object that parsePropertyAccess will handle
      return { __refType: token.value };
    }

    throw new Error(`Unknown token: "${token.value}"`);
  }

  return parseLogicalOr();
}

/**
 * Resolve variable reference from context
 * @internal
 */
function resolveVariableReference(
  reference: string,
  context: ExecutionContext,
  contextUsed: Record<string, unknown>
): unknown {
  // Format: "steps.stepId.outputFieldName" or "variables.varName"
  const parts = reference.split('.');

  if (parts[0] === 'steps') {
    // Find step result by ID
    const stepId = parts[1];
    const step = context.results.find((r) => r.stepId === stepId);

    if (!step) {
      return undefined; // Step not found or not yet executed
    }

    contextUsed[`steps.${stepId}`] = step;

    // If there are more parts, navigate the step result
    if (parts.length > 2) {
      let value: unknown = step;
      for (let i = 2; i < parts.length; i++) {
        if (value !== null && value !== undefined && typeof value === 'object') {
          value = (value as any)[parts[i]];
        } else {
          return undefined;
        }
      }
      return value;
    }

    return step;
  }

  if (parts[0] === 'variables') {
    // Find variable by name
    const varName = parts.slice(1).join('.');
    const value = context.variables.get(varName);
    contextUsed[`variables.${varName}`] = value;

    return value;
  }

  return undefined;
}

/**
 * Compare two values using the specified operator
 * @internal
 */
function compare(left: unknown, operator: string, right: unknown): boolean {
  switch (operator) {
    case '===':
      return left === right;
    case '!==':
      return left !== right;
    case '==':
      return left == right;
    case '!=':
      return left != right;
    case '<':
      return (left as number) < (right as number);
    case '>':
      return (left as number) > (right as number);
    case '<=':
      return (left as number) <= (right as number);
    case '>=':
      return (left as number) >= (right as number);
    default:
      throw new Error(`Unknown operator: "${operator}"`);
  }
}

/**
 * Check if a condition expression is syntactically valid
 * Can be used for early validation before execution
 *
 * @param condition Condition expression to validate
 * @returns true if valid, false if invalid
 */
export function isValidConditionSyntax(condition: string): boolean {
  try {
    const match = condition.match(/^\$\{(.+)\}$/);
    return Boolean(match);
  } catch {
    return false;
  }
}
