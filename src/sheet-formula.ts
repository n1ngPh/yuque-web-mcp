import type { SheetScalar, SheetWorksheet } from "./sheet-model.js";

const MAX_FORMULA_CHARACTERS = 2_000;
const MAX_FORMULA_TOKENS = 1_000;
const MAX_RANGE_CELLS = 10_000;
const MAX_FORMULA_TEXT_RESULT_CHARACTERS = 10_000;

export const VERIFIED_SHEET_FUNCTIONS = [
  "SUM",
  "AVERAGE",
  "MIN",
  "MAX",
  "COUNT",
  "COUNTA",
  "IF",
  "AND",
  "OR",
  "NOT",
  "IFS",
  "SWITCH",
  "XOR",
  "COUNTIF",
  "SUMIF",
  "COUNTIFS",
  "SUMIFS",
  "AVERAGEIF",
  "AVERAGEIFS",
  "COUNTBLANK",
  "LARGE",
  "SMALL",
  "STDEVP",
  "VARP",
  "STDEVS",
  "VARS",
  "ISBLANK",
  "ISNUMBER",
  "ISTEXT",
  "ISLOGICAL",
  "ISEVEN",
  "ISODD",
  "ABS",
  "ROUND",
  "CEILING",
  "FLOOR",
  "SUMPRODUCT",
  "CHOOSE",
  "RANK",
  "SIGN",
  "PI",
  "EXP",
  "LN",
  "LOG",
  "LOG10",
  "TRUNC",
  "MROUND",
  "QUOTIENT",
  "SIN",
  "COS",
  "TAN",
  "DEGREES",
  "RADIANS",
  "FACT",
  "GCD",
  "LCM",
  "COMBIN",
  "SUMSQ",
  "CONCAT",
  "CONCATENATE",
  "LEFT",
  "RIGHT",
  "MID",
  "LEN",
  "LOWER",
  "UPPER",
  "TRIM",
  "FIND",
  "SEARCH",
  "SUBSTITUTE",
  "REPLACE",
  "REPT",
  "EXACT",
  "PROPER",
  "CHAR",
  "CODE",
  "VALUE",
  "TEXT",
  "ROUNDUP",
  "ROUNDDOWN",
  "INT",
  "MOD",
  "SQRT",
  "POWER",
  "PRODUCT",
  "MEDIAN",
  "VLOOKUP",
  "HLOOKUP",
  "MATCH",
  "INDEX",
  "ROWS",
  "COLUMNS",
] as const;

interface RangeValue {
  kind: "range";
  values: SheetScalar[];
  rowCount: number;
  columnCount: number;
}

type FormulaValue = SheetScalar | RangeValue;
type TokenType =
  | "number"
  | "string"
  | "cell"
  | "identifier"
  | "operator"
  | "left_paren"
  | "right_paren"
  | "comma"
  | "colon"
  | "eof";

interface Token {
  type: TokenType;
  value: string;
}

export function recalculateSheetFormulas(
  worksheet: SheetWorksheet,
  addresses: Iterable<string>,
): void {
  const targets = new Set(Array.from(addresses, normalizeCellAddress));
  const computed = new Map<string, SheetScalar>();
  const visiting = new Set<string>();

  const evaluateCell = (address: string): SheetScalar => {
    const normalized = normalizeCellAddress(address);
    if (computed.has(normalized)) return computed.get(normalized)!;
    const cell = worksheet.cells[normalized];
    if (!cell) return null;
    if (!targets.has(normalized) || !cell.formula) return cell.value;
    if (visiting.has(normalized)) {
      throw new Error(
        `Formula cycle detected at ${worksheet.name}!${normalized}`,
      );
    }
    visiting.add(normalized);
    try {
      const value = new FormulaParser(
        cell.formula,
        worksheet,
        evaluateCell,
      ).parse();
      computed.set(normalized, value);
      return value;
    } finally {
      visiting.delete(normalized);
    }
  };

  for (const address of targets) {
    const cell = worksheet.cells[address];
    if (!cell?.formula) continue;
    cell.value = evaluateCell(address);
    cell.kind = "formula";
  }
}

class FormulaParser {
  private readonly tokens: Token[];
  private cursor = 0;

  constructor(
    formula: string,
    private readonly worksheet: SheetWorksheet,
    private readonly evaluateCell: (address: string) => SheetScalar,
  ) {
    const source = formula.trim().replace(/^=/, "");
    if (!source || source.length > MAX_FORMULA_CHARACTERS) {
      throw new Error("Formula is empty or exceeds the safe length limit");
    }
    this.tokens = tokenize(source);
  }

  parse(): SheetScalar {
    const value = this.parseComparison();
    this.consume("eof", "Unexpected trailing formula input");
    if (isRange(value)) throw new Error("A formula cannot return a range");
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error("Formula result is not a finite number");
    }
    return value;
  }

  private parseComparison(): FormulaValue {
    let value = this.parseAdditive();
    while (this.matchesOperator("=", "<>", "<", ">", "<=", ">=")) {
      const operator = this.previous().value;
      const right = this.parseAdditive();
      value = compareValues(value, right, operator);
    }
    return value;
  }

  private parseAdditive(): FormulaValue {
    let value = this.parseMultiplicative();
    while (this.matchesOperator("+", "-")) {
      const operator = this.previous().value;
      const right = this.parseMultiplicative();
      value =
        operator === "+"
          ? numeric(value) + numeric(right)
          : numeric(value) - numeric(right);
    }
    return value;
  }

  private parseMultiplicative(): FormulaValue {
    let value = this.parseUnary();
    while (this.matchesOperator("*", "/")) {
      const operator = this.previous().value;
      const right = numeric(this.parseUnary());
      if (operator === "/" && right === 0) {
        throw new Error("Formula division by zero is not allowed");
      }
      value =
        operator === "*" ? numeric(value) * right : numeric(value) / right;
    }
    return value;
  }

  private parseUnary(): FormulaValue {
    if (this.matchesOperator("+")) return numeric(this.parseUnary());
    if (this.matchesOperator("-")) return -numeric(this.parseUnary());
    return this.parsePrimary();
  }

  private parsePrimary(): FormulaValue {
    if (this.matches("number")) return Number(this.previous().value);
    if (this.matches("string")) return this.previous().value;
    if (this.matches("cell")) {
      const start = normalizeCellAddress(this.previous().value);
      if (this.matches("colon")) {
        const end = normalizeCellAddress(
          this.consume("cell", "A range must end with a cell reference").value,
        );
        const expanded = expandRange(start, end);
        return {
          kind: "range",
          values: expanded.addresses.map(this.evaluateCell),
          rowCount: expanded.rowCount,
          columnCount: expanded.columnCount,
        };
      }
      return this.evaluateCell(start);
    }
    if (this.matches("identifier")) {
      const identifier = this.previous().value.toUpperCase();
      if (identifier === "TRUE") return true;
      if (identifier === "FALSE") return false;
      this.consume("left_paren", "A function name must be followed by '('");
      const args: FormulaValue[] = [];
      if (!this.check("right_paren")) {
        do {
          args.push(this.parseComparison());
        } while (this.matches("comma"));
      }
      this.consume("right_paren", "A function call is missing ')'");
      return evaluateFunction(identifier, args);
    }
    if (this.matches("left_paren")) {
      const value = this.parseComparison();
      this.consume("right_paren", "A formula group is missing ')'");
      return value;
    }
    throw new Error(`Unexpected formula token '${this.peek().value}'`);
  }

  private matches(type: TokenType): boolean {
    if (!this.check(type)) return false;
    this.cursor += 1;
    return true;
  }

  private matchesOperator(...operators: string[]): boolean {
    if (
      this.peek().type !== "operator" ||
      !operators.includes(this.peek().value)
    ) {
      return false;
    }
    this.cursor += 1;
    return true;
  }

  private consume(type: TokenType, message: string): Token {
    if (!this.check(type)) throw new Error(message);
    return this.tokens[this.cursor++]!;
  }

  private check(type: TokenType): boolean {
    return this.peek().type === type;
  }

  private peek(): Token {
    return this.tokens[this.cursor]!;
  }

  private previous(): Token {
    return this.tokens[this.cursor - 1]!;
  }
}

function evaluateFunction(name: string, args: FormulaValue[]): SheetScalar {
  if (!(VERIFIED_SHEET_FUNCTIONS as readonly string[]).includes(name)) {
    throw new Error(`Unsupported Sheet formula function: ${name}`);
  }
  if (name === "SUM") {
    if (args.length === 0) throw new Error("SUM requires an argument");
    return flatten(args)
      .filter((value): value is number => typeof value === "number")
      .reduce((total, value) => total + value, 0);
  }
  if (name === "AVERAGE") {
    if (args.length === 0) throw new Error("AVERAGE requires an argument");
    const values = flatten(args).filter(
      (value): value is number => typeof value === "number",
    );
    if (values.length === 0) {
      throw new Error("AVERAGE requires at least one numeric value");
    }
    return values.reduce((total, value) => total + value, 0) / values.length;
  }
  if (name === "MIN" || name === "MAX") {
    if (args.length === 0) throw new Error(`${name} requires an argument`);
    const values = flatten(args).filter(
      (value): value is number => typeof value === "number",
    );
    if (values.length === 0) {
      throw new Error(`${name} requires at least one numeric value`);
    }
    return name === "MIN" ? Math.min(...values) : Math.max(...values);
  }
  if (name === "COUNT") {
    if (args.length === 0) throw new Error("COUNT requires an argument");
    return flatten(args).filter((value) => typeof value === "number").length;
  }
  if (name === "COUNTA") {
    if (args.length === 0) throw new Error("COUNTA requires an argument");
    return flatten(args).filter((value) => value !== null && value !== "")
      .length;
  }
  if (name === "IF") {
    if (args.length !== 3) throw new Error("IF requires three arguments");
    const whenTrue = ensureScalar(args[1]!);
    const whenFalse = ensureScalar(args[2]!);
    return truthy(args[0]!) ? whenTrue : whenFalse;
  }
  if (name === "AND" || name === "OR") {
    if (args.length === 0) throw new Error(`${name} requires an argument`);
    return name === "AND" ? args.every(truthy) : args.some(truthy);
  }
  if (name === "NOT") {
    if (args.length !== 1) throw new Error("NOT requires one argument");
    return !truthy(args[0]!);
  }
  if (name === "XOR") {
    if (args.length < 2 || args.length > 255) {
      throw new Error("XOR requires two to 255 scalar arguments");
    }
    return args.reduce<boolean>(
      (odd, argument) => (truthy(argument) ? !odd : odd),
      false,
    );
  }
  if (name === "IFS") {
    if (args.length < 2 || args.length > 254 || args.length % 2 !== 0) {
      throw new Error("IFS requires one to 127 condition/result pairs");
    }
    for (let index = 0; index < args.length; index += 2) {
      if (truthy(args[index]!)) return ensureScalar(args[index + 1]!);
    }
    throw new Error("IFS has no matching condition");
  }
  if (name === "SWITCH") {
    if (args.length < 3 || args.length > 254) {
      throw new Error(
        "SWITCH requires an expression, one or more case/result pairs and an optional default",
      );
    }
    const expression = ensureScalar(args[0]!);
    const hasDefault = args.length % 2 === 0;
    const pairEnd = hasDefault ? args.length - 1 : args.length;
    for (let index = 1; index < pairEnd; index += 2) {
      const candidate = ensureScalar(args[index]!);
      if (lookupValuesEqual(expression, candidate)) {
        return ensureScalar(args[index + 1]!);
      }
    }
    if (hasDefault) return ensureScalar(args.at(-1)!);
    throw new Error("SWITCH has no matching case or default");
  }
  if (name === "COUNTIF") {
    if (args.length !== 2 || !isRange(args[0]!)) {
      throw new Error("COUNTIF requires a range and one criterion");
    }
    const criterion = ensureScalar(args[1]!);
    return args[0].values.filter((value) => matchesCriterion(value, criterion))
      .length;
  }
  if (name === "SUMIF") {
    if (
      (args.length !== 2 && args.length !== 3) ||
      !isRange(args[0]!) ||
      (args.length === 3 && !isRange(args[2]!))
    ) {
      throw new Error(
        "SUMIF requires a range, one criterion and an optional sum range",
      );
    }
    const criterion = ensureScalar(args[1]!);
    const sumValues =
      args.length === 3 ? (args[2] as RangeValue).values : args[0].values;
    if (
      sumValues.length !== args[0].values.length ||
      (args.length === 3 &&
        ((args[2] as RangeValue).rowCount !== args[0].rowCount ||
          (args[2] as RangeValue).columnCount !== args[0].columnCount))
    ) {
      throw new Error("SUMIF range and sum range must have equal dimensions");
    }
    return args[0].values.reduce<number>((total, value, index) => {
      if (!matchesCriterion(value, criterion)) return total;
      const candidate = sumValues[index];
      return total + (typeof candidate === "number" ? candidate : 0);
    }, 0);
  }
  if (name === "COUNTIFS") {
    const criteria = requireCriteriaPairs(name, args);
    return criteria[0]!.range.values.reduce<number>((count, _value, index) => {
      return criteria.every(({ range, criterion }) =>
        matchesCriterion(range.values[index] ?? null, criterion),
      )
        ? count + 1
        : count;
    }, 0);
  }
  if (name === "SUMIFS" || name === "AVERAGEIFS") {
    if (args.length < 3 || args.length % 2 !== 1) {
      throw new Error(
        `${name} requires a value range and one or more range/criterion pairs`,
      );
    }
    const valueRange = requireRange(args[0]!, `${name} value range`);
    const criteria = requireCriteriaPairs(name, args.slice(1), valueRange);
    const matches = valueRange.values.filter((_value, index) =>
      criteria.every(({ range, criterion }) =>
        matchesCriterion(range.values[index] ?? null, criterion),
      ),
    );
    const numericMatches = matches.filter(
      (value): value is number => typeof value === "number",
    );
    if (name === "SUMIFS") {
      return numericMatches.reduce((total, value) => total + value, 0);
    }
    if (numericMatches.length === 0) {
      throw new Error(
        "AVERAGEIFS requires at least one matching numeric value",
      );
    }
    return (
      numericMatches.reduce((total, value) => total + value, 0) /
      numericMatches.length
    );
  }
  if (name === "AVERAGEIF") {
    if (
      (args.length !== 2 && args.length !== 3) ||
      !isRange(args[0]!) ||
      (args.length === 3 && !isRange(args[2]!))
    ) {
      throw new Error(
        "AVERAGEIF requires a range, one criterion and an optional average range",
      );
    }
    const criterion = ensureScalar(args[1]!);
    const criteriaRange = args[0];
    const averageRange = args.length === 3 ? (args[2] as RangeValue) : args[0];
    requireEqualRangeDimensions("AVERAGEIF", criteriaRange, averageRange);
    const matches = averageRange.values.filter((_value, index) =>
      matchesCriterion(criteriaRange.values[index] ?? null, criterion),
    );
    const numericMatches = matches.filter(
      (value): value is number => typeof value === "number",
    );
    if (numericMatches.length === 0) {
      throw new Error("AVERAGEIF requires at least one matching numeric value");
    }
    return (
      numericMatches.reduce((total, value) => total + value, 0) /
      numericMatches.length
    );
  }
  if (name === "COUNTBLANK") {
    if (args.length !== 1 || !isRange(args[0]!)) {
      throw new Error("COUNTBLANK requires one cell range");
    }
    return args[0].values.filter((value) => value === null || value === "")
      .length;
  }
  if (name === "LARGE" || name === "SMALL") {
    if (args.length !== 2 || !isRange(args[0]!)) {
      throw new Error(`${name} requires a numeric range and one rank`);
    }
    const values = args[0].values
      .filter((value): value is number => typeof value === "number")
      .sort((left, right) => left - right);
    if (values.length === 0) {
      throw new Error(`${name} requires at least one numeric value`);
    }
    const rank = boundedInteger(args[1]!, `${name} rank`, 1, values.length);
    return name === "LARGE" ? values[values.length - rank]! : values[rank - 1]!;
  }
  if (
    name === "STDEVP" ||
    name === "VARP" ||
    name === "STDEVS" ||
    name === "VARS"
  ) {
    if (args.length !== 1 || !isRange(args[0]!)) {
      throw new Error(`${name} requires exactly one numeric cell range`);
    }
    const values = args[0].values.filter(
      (value): value is number => typeof value === "number",
    );
    const population = name === "STDEVP" || name === "VARP";
    const minimum = population ? 1 : 2;
    if (values.length < minimum) {
      throw new Error(
        `${name} requires at least ${String(minimum)} numeric value${minimum === 1 ? "" : "s"}`,
      );
    }
    const mean =
      values.reduce((total, value) => total + value, 0) / values.length;
    const divisor = population ? values.length : values.length - 1;
    const variance = finiteFormulaResult(
      values.reduce((total, value) => total + (value - mean) ** 2, 0) / divisor,
      name,
    );
    return name === "STDEVP" || name === "STDEVS"
      ? finiteFormulaResult(Math.sqrt(variance), name)
      : variance;
  }
  if (
    name === "ISBLANK" ||
    name === "ISNUMBER" ||
    name === "ISTEXT" ||
    name === "ISLOGICAL"
  ) {
    if (args.length !== 1) throw new Error(`${name} requires one argument`);
    const value = ensureScalar(args[0]!);
    if (name === "ISBLANK") return value === null;
    if (name === "ISNUMBER") return typeof value === "number";
    if (name === "ISTEXT") return typeof value === "string";
    return typeof value === "boolean";
  }
  if (name === "ISEVEN" || name === "ISODD") {
    if (args.length !== 1) throw new Error(`${name} requires one argument`);
    const value = numeric(args[0]!);
    if (!Number.isSafeInteger(value)) {
      throw new Error(`${name} requires a safe integer`);
    }
    const even = Math.abs(value % 2) === 0;
    return name === "ISEVEN" ? even : !even;
  }
  if (name === "ABS") {
    if (args.length !== 1) throw new Error("ABS requires one argument");
    return Math.abs(numeric(args[0]!));
  }
  if (name === "ROUND") {
    if (args.length !== 2) throw new Error("ROUND requires two arguments");
    const value = numeric(args[0]!);
    const digits = numeric(args[1]!);
    if (!Number.isSafeInteger(digits) || digits < -15 || digits > 15) {
      throw new Error("ROUND digits must be an integer between -15 and 15");
    }
    const factor = 10 ** Math.abs(digits);
    return digits >= 0
      ? Math.round((value + Math.sign(value) * Number.EPSILON) * factor) /
          factor
      : Math.round(value / factor) * factor;
  }
  if (name === "CEILING" || name === "FLOOR") {
    if (args.length !== 2) throw new Error(`${name} requires two arguments`);
    const value = numeric(args[0]!);
    const significance = numeric(args[1]!);
    if (value < 0 || significance <= 0) {
      throw new Error(
        `${name} only supports a non-negative value and positive significance`,
      );
    }
    const quotient = value / significance;
    const tolerance = Number.EPSILON * Math.max(1, Math.abs(quotient)) * 4;
    const multiple =
      name === "CEILING"
        ? Math.ceil(quotient - tolerance)
        : Math.floor(quotient + tolerance);
    return finiteFormulaResult(multiple * significance, name);
  }
  if (name === "SUMPRODUCT") {
    if (args.length !== 2) {
      throw new Error("SUMPRODUCT only supports two verified ranges");
    }
    const first = requireRange(args[0]!, "SUMPRODUCT first range");
    const second = requireRange(args[1]!, "SUMPRODUCT second range");
    requireEqualRangeDimensions("SUMPRODUCT", first, second);
    if (
      first.values.some((value) => typeof value !== "number") ||
      second.values.some((value) => typeof value !== "number")
    ) {
      throw new Error("SUMPRODUCT only supports fully numeric ranges");
    }
    const firstValues = first.values as number[];
    const secondValues = second.values as number[];
    return finiteFormulaResult(
      firstValues.reduce<number>(
        (total, value, index) => total + value * secondValues[index]!,
        0,
      ),
      name,
    );
  }
  if (name === "CHOOSE") {
    if (args.length < 2 || args.length > 255) {
      throw new Error("CHOOSE requires an index and one to 254 values");
    }
    const values = args.slice(1).map(ensureScalar);
    const index = boundedInteger(args[0]!, "CHOOSE index", 1, values.length);
    return values[index - 1]!;
  }
  if (name === "RANK") {
    if (args.length !== 3) {
      throw new Error("RANK requires a number, range and order");
    }
    const value = numeric(args[0]!);
    const range = requireRange(args[1]!, "RANK range");
    const order = ensureScalar(args[2]!);
    if (order !== 0) {
      throw new Error("RANK only supports verified descending order 0");
    }
    if (
      range.values.length === 0 ||
      range.values.some((candidate) => typeof candidate !== "number")
    ) {
      throw new Error("RANK only supports a fully numeric range");
    }
    return (
      1 +
      (range.values as number[]).filter((candidate) => candidate > value).length
    );
  }
  if (name === "SIGN") {
    if (args.length !== 1) throw new Error("SIGN requires one argument");
    return finiteFormulaResult(Math.sign(numeric(args[0]!)), name);
  }
  if (name === "PI") {
    if (args.length !== 0) throw new Error("PI does not accept arguments");
    return Math.PI;
  }
  if (name === "EXP") {
    if (args.length !== 1) throw new Error("EXP requires one argument");
    return finiteFormulaResult(Math.exp(numeric(args[0]!)), name);
  }
  if (name === "LN" || name === "LOG10") {
    if (args.length !== 1) throw new Error(`${name} requires one argument`);
    const value = numeric(args[0]!);
    if (value <= 0) throw new Error(`${name} requires a positive number`);
    return finiteFormulaResult(
      name === "LN" ? Math.log(value) : Math.log10(value),
      name,
    );
  }
  if (name === "LOG") {
    if (args.length !== 2) {
      throw new Error("LOG only supports the verified two-argument form");
    }
    const value = numeric(args[0]!);
    const base = numeric(args[1]!);
    if (value <= 0 || base <= 0 || base === 1) {
      throw new Error(
        "LOG requires a positive number and a positive base other than 1",
      );
    }
    return finiteFormulaResult(Math.log(value) / Math.log(base), name);
  }
  if (name === "TRUNC") {
    if (args.length !== 2) {
      throw new Error("TRUNC only supports the verified two-argument form");
    }
    const value = numeric(args[0]!);
    const digits = boundedInteger(args[1]!, "TRUNC digits", -15, 15);
    const factor = 10 ** Math.abs(digits);
    return finiteFormulaResult(
      digits >= 0
        ? Math.trunc(value * factor) / factor
        : Math.trunc(value / factor) * factor,
      name,
    );
  }
  if (name === "MROUND") {
    if (args.length !== 2) throw new Error("MROUND requires two arguments");
    const value = numeric(args[0]!);
    const multiple = numeric(args[1]!);
    if (value < 0 || multiple <= 0) {
      throw new Error(
        "MROUND only supports a non-negative value and positive multiple",
      );
    }
    const quotient = value / multiple;
    const tolerance = Number.EPSILON * Math.max(1, quotient) * 4;
    return finiteFormulaResult(
      Math.floor(quotient + 0.5 + tolerance) * multiple,
      name,
    );
  }
  if (name === "QUOTIENT") {
    if (args.length !== 2) throw new Error("QUOTIENT requires two arguments");
    const numerator = numeric(args[0]!);
    const denominator = numeric(args[1]!);
    if (denominator === 0) {
      throw new Error("QUOTIENT denominator cannot be zero");
    }
    return finiteFormulaResult(Math.trunc(numerator / denominator), name);
  }
  if (name === "SIN" || name === "COS" || name === "TAN") {
    if (args.length !== 1) throw new Error(`${name} requires one argument`);
    const value = numeric(args[0]!);
    return finiteFormulaResult(
      name === "SIN"
        ? Math.sin(value)
        : name === "COS"
          ? Math.cos(value)
          : Math.tan(value),
      name,
    );
  }
  if (name === "DEGREES" || name === "RADIANS") {
    if (args.length !== 1) throw new Error(`${name} requires one argument`);
    const value = numeric(args[0]!);
    return finiteFormulaResult(
      name === "DEGREES" ? (value * 180) / Math.PI : (value * Math.PI) / 180,
      name,
    );
  }
  if (name === "FACT") {
    if (args.length !== 1) throw new Error("FACT requires one argument");
    const value = boundedInteger(args[0]!, "FACT value", 0, 170);
    let result = 1;
    for (let candidate = 2; candidate <= value; candidate += 1) {
      result *= candidate;
    }
    return finiteFormulaResult(result, name);
  }
  if (name === "GCD" || name === "LCM") {
    if (args.length < 1 || args.length > 255) {
      throw new Error(`${name} requires one to 255 arguments`);
    }
    const values = args.map((argument, index) =>
      boundedInteger(
        argument,
        `${name} argument ${String(index + 1)}`,
        0,
        1_000_000_000,
      ),
    );
    const gcd = (first: number, second: number): number => {
      let left = first;
      let right = second;
      while (right !== 0) {
        [left, right] = [right, left % right];
      }
      return left;
    };
    if (name === "GCD") return values.reduce(gcd);
    const result = values.reduce((current, value) => {
      if (current === 0 || value === 0) return 0;
      const next = (current / gcd(current, value)) * value;
      if (!Number.isSafeInteger(next)) {
        throw new Error("LCM result exceeds the safe integer limit");
      }
      return next;
    });
    return result;
  }
  if (name === "COMBIN") {
    if (args.length !== 2) throw new Error("COMBIN requires two arguments");
    const total = boundedInteger(args[0]!, "COMBIN total", 0, 170);
    const selected = boundedInteger(args[1]!, "COMBIN selected", 0, total);
    const count = Math.min(selected, total - selected);
    let result = 1;
    for (let index = 1; index <= count; index += 1) {
      result = (result * (total - count + index)) / index;
    }
    return finiteFormulaResult(result, name);
  }
  if (name === "SUMSQ") {
    if (args.length < 1 || args.length > 255) {
      throw new Error("SUMSQ requires one to 255 scalar arguments");
    }
    return finiteFormulaResult(
      args.reduce<number>((total, argument) => {
        const value = numeric(argument);
        return total + value * value;
      }, 0),
      name,
    );
  }
  if (name === "CONCAT" || name === "CONCATENATE") {
    if (args.length === 0) throw new Error(`${name} requires an argument`);
    return args.map(formulaText).join("");
  }
  if (name === "LEFT" || name === "RIGHT") {
    if (args.length !== 2) {
      throw new Error(`${name} requires text and a character count`);
    }
    const value = formulaText(args[0]!);
    const count = safeTextInteger(args[1]!, `${name} character count`);
    return name === "LEFT"
      ? value.slice(0, count)
      : count === 0
        ? ""
        : value.slice(-count);
  }
  if (name === "MID") {
    if (args.length !== 3) {
      throw new Error("MID requires text, a start position and a length");
    }
    const value = formulaText(args[0]!);
    const start = safeTextInteger(args[1]!, "MID start position");
    const length = safeTextInteger(args[2]!, "MID length");
    if (start < 1) throw new Error("MID start position must be at least 1");
    return value.slice(start - 1, start - 1 + length);
  }
  if (name === "LEN") {
    if (args.length !== 1) throw new Error("LEN requires one argument");
    return formulaText(args[0]!).length;
  }
  if (name === "LOWER" || name === "UPPER" || name === "TRIM") {
    if (args.length !== 1) throw new Error(`${name} requires one argument`);
    const value = formulaText(args[0]!);
    if (name === "LOWER") return value.toLowerCase();
    if (name === "UPPER") return value.toUpperCase();
    return value.trim();
  }
  if (name === "FIND" || name === "SEARCH") {
    if (args.length !== 3) {
      throw new Error(
        `${name} requires search text, source text and start position`,
      );
    }
    const needle = formulaText(args[0]!);
    const source = formulaText(args[1]!);
    if (!needle) throw new Error(`${name} search text cannot be empty`);
    const start = boundedInteger(
      args[2]!,
      `${name} start position`,
      1,
      Math.max(1, source.length),
    );
    const haystack = name === "SEARCH" ? source.toLowerCase() : source;
    const normalizedNeedle = name === "SEARCH" ? needle.toLowerCase() : needle;
    const index = haystack.indexOf(normalizedNeedle, start - 1);
    if (index < 0) throw new Error(`${name} did not find the search text`);
    return index + 1;
  }
  if (name === "SUBSTITUTE") {
    if (args.length !== 3) {
      throw new Error(
        "SUBSTITUTE only supports the verified three-argument form",
      );
    }
    const source = formulaText(args[0]!);
    const oldText = formulaText(args[1]!);
    const newText = formulaText(args[2]!);
    if (!oldText) throw new Error("SUBSTITUTE old text cannot be empty");
    return boundedFormulaTextResult(
      source.split(oldText).join(newText),
      "SUBSTITUTE",
    );
  }
  if (name === "REPLACE") {
    if (args.length !== 4) {
      throw new Error(
        "REPLACE requires text, start position, length and new text",
      );
    }
    const source = formulaText(args[0]!);
    const start = boundedInteger(
      args[1]!,
      "REPLACE start position",
      1,
      source.length + 1,
    );
    const length = safeTextInteger(args[2]!, "REPLACE length");
    return boundedFormulaTextResult(
      `${source.slice(0, start - 1)}${formulaText(args[3]!)}${source.slice(start - 1 + length)}`,
      "REPLACE",
    );
  }
  if (name === "REPT") {
    if (args.length !== 2)
      throw new Error("REPT requires text and repeat count");
    const value = formulaText(args[0]!);
    const count = safeTextInteger(args[1]!, "REPT repeat count");
    if (value.length * count > MAX_FORMULA_TEXT_RESULT_CHARACTERS) {
      throw new Error("REPT result exceeds the safe text length limit");
    }
    return boundedFormulaTextResult(value.repeat(count), "REPT");
  }
  if (name === "EXACT") {
    if (args.length !== 2) throw new Error("EXACT requires two text values");
    return formulaText(args[0]!) === formulaText(args[1]!);
  }
  if (name === "PROPER") {
    if (args.length !== 1) throw new Error("PROPER requires one text value");
    const source = formulaText(args[0]!);
    if (!/^[\x20-\x7e]*$/.test(source)) {
      throw new Error("PROPER is verified only for printable ASCII text");
    }
    return boundedFormulaTextResult(
      source
        .toLowerCase()
        .replace(
          /[A-Za-z]+/g,
          (word) => `${word[0]!.toUpperCase()}${word.slice(1)}`,
        ),
      name,
    );
  }
  if (name === "CHAR") {
    if (args.length !== 1) throw new Error("CHAR requires one character code");
    return String.fromCharCode(boundedInteger(args[0]!, "CHAR code", 1, 255));
  }
  if (name === "CODE") {
    if (args.length !== 1) throw new Error("CODE requires one text value");
    const source = formulaText(args[0]!);
    if (!source) throw new Error("CODE requires non-empty text");
    const code = source.charCodeAt(0);
    if (code > 255) {
      throw new Error("CODE is verified only for single-byte characters");
    }
    return code;
  }
  if (name === "VALUE") {
    if (args.length !== 1) throw new Error("VALUE requires one text value");
    const source = formulaText(args[0]!).trim();
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?$/.test(source)) {
      throw new Error(
        "VALUE is verified only for locale-independent decimal text",
      );
    }
    return finiteFormulaResult(Number(source), name);
  }
  if (name === "TEXT") {
    if (args.length !== 2) {
      throw new Error("TEXT requires a numeric value and format");
    }
    return formatVerifiedTextNumber(numeric(args[0]!), formulaText(args[1]!));
  }
  if (name === "ROUNDUP" || name === "ROUNDDOWN") {
    if (args.length !== 2) throw new Error(`${name} requires two arguments`);
    const value = numeric(args[0]!);
    const digits = boundedInteger(args[1]!, `${name} digits`, -15, 15);
    return directionalRound(value, digits, name === "ROUNDUP");
  }
  if (name === "INT") {
    if (args.length !== 1) throw new Error("INT requires one argument");
    return Math.floor(numeric(args[0]!));
  }
  if (name === "MOD") {
    if (args.length !== 2) throw new Error("MOD requires two arguments");
    const dividend = numeric(args[0]!);
    const divisor = numeric(args[1]!);
    if (divisor === 0) throw new Error("MOD divisor cannot be zero");
    return ((dividend % divisor) + divisor) % divisor;
  }
  if (name === "SQRT") {
    if (args.length !== 1) throw new Error("SQRT requires one argument");
    const value = numeric(args[0]!);
    if (value < 0) throw new Error("SQRT requires a non-negative number");
    return Math.sqrt(value);
  }
  if (name === "POWER") {
    if (args.length !== 2) throw new Error("POWER requires two arguments");
    return finiteFormulaResult(
      Math.pow(numeric(args[0]!), numeric(args[1]!)),
      "POWER",
    );
  }
  if (name === "PRODUCT" || name === "MEDIAN") {
    if (args.length === 0) throw new Error(`${name} requires an argument`);
    const values = flatten(args).filter(
      (value): value is number => typeof value === "number",
    );
    if (values.length === 0) {
      throw new Error(`${name} requires at least one numeric value`);
    }
    if (name === "PRODUCT") {
      return finiteFormulaResult(
        values.reduce((product, value) => product * value, 1),
        "PRODUCT",
      );
    }
    values.sort((left, right) => left - right);
    const middle = Math.floor(values.length / 2);
    return values.length % 2 === 1
      ? values[middle]!
      : (values[middle - 1]! + values[middle]!) / 2;
  }
  if (name === "VLOOKUP" || name === "HLOOKUP") {
    if (args.length !== 4) {
      throw new Error(`${name} requires four arguments`);
    }
    const lookupValue = ensureScalar(args[0]!);
    const table = requireRange(args[1]!, `${name} table`);
    const returnIndex = boundedInteger(
      args[2]!,
      `${name} return index`,
      1,
      name === "VLOOKUP" ? table.columnCount : table.rowCount,
    );
    requireExactLookupMode(args[3]!, name);
    if (name === "VLOOKUP") {
      for (let row = 0; row < table.rowCount; row += 1) {
        if (lookupValuesEqual(rangeValueAt(table, row, 0), lookupValue)) {
          return rangeValueAt(table, row, returnIndex - 1);
        }
      }
    } else {
      for (let column = 0; column < table.columnCount; column += 1) {
        if (lookupValuesEqual(rangeValueAt(table, 0, column), lookupValue)) {
          return rangeValueAt(table, returnIndex - 1, column);
        }
      }
    }
    throw new Error(`${name} exact lookup did not find a match`);
  }
  if (name === "MATCH") {
    if (args.length !== 3) throw new Error("MATCH requires three arguments");
    const lookupValue = ensureScalar(args[0]!);
    const range = requireRange(args[1]!, "MATCH range");
    if (range.rowCount !== 1 && range.columnCount !== 1) {
      throw new Error("MATCH requires a one-row or one-column range");
    }
    requireExactLookupMode(args[2]!, name);
    const index = range.values.findIndex((value) =>
      lookupValuesEqual(value, lookupValue),
    );
    if (index < 0) throw new Error("MATCH exact lookup did not find a match");
    return index + 1;
  }
  if (name === "INDEX") {
    if (args.length !== 3) {
      throw new Error("INDEX requires a range, row and column");
    }
    const range = requireRange(args[0]!, "INDEX range");
    const row = boundedInteger(args[1]!, "INDEX row", 1, range.rowCount);
    const column = boundedInteger(
      args[2]!,
      "INDEX column",
      1,
      range.columnCount,
    );
    return rangeValueAt(range, row - 1, column - 1);
  }
  if (name === "ROWS" || name === "COLUMNS") {
    if (args.length !== 1) throw new Error(`${name} requires one range`);
    const range = requireRange(args[0]!, `${name} value`);
    return name === "ROWS" ? range.rowCount : range.columnCount;
  }
  throw new Error(`Unsupported Sheet formula function: ${name}`);
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let cursor = 0;
  const push = (type: TokenType, value: string) => {
    tokens.push({ type, value });
    if (tokens.length > MAX_FORMULA_TOKENS) {
      throw new Error("Formula exceeds the safe token limit");
    }
  };
  while (cursor < source.length) {
    const character = source[cursor]!;
    if (/\s/.test(character)) {
      cursor += 1;
      continue;
    }
    if (character === '"') {
      cursor += 1;
      let value = "";
      let closed = false;
      while (cursor < source.length) {
        if (source[cursor] === '"') {
          if (source[cursor + 1] === '"') {
            value += '"';
            cursor += 2;
            continue;
          }
          cursor += 1;
          closed = true;
          break;
        }
        value += source[cursor]!;
        cursor += 1;
      }
      if (!closed) throw new Error("Formula string is unterminated");
      push("string", value);
      continue;
    }
    const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?/.exec(
      source.slice(cursor),
    )?.[0];
    if (number) {
      push("number", number);
      cursor += number.length;
      continue;
    }
    const twoCharacters = source.slice(cursor, cursor + 2);
    if (["<=", ">=", "<>"].includes(twoCharacters)) {
      push("operator", twoCharacters);
      cursor += 2;
      continue;
    }
    const punctuation: Record<string, TokenType> = {
      "(": "left_paren",
      ")": "right_paren",
      ",": "comma",
      ":": "colon",
    };
    if (punctuation[character]) {
      push(punctuation[character]!, character);
      cursor += 1;
      continue;
    }
    if (["+", "-", "*", "/", "=", "<", ">"].includes(character)) {
      push("operator", character);
      cursor += 1;
      continue;
    }
    const word = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(source.slice(cursor))?.[0];
    if (word) {
      const followedByLeftParenthesis = source[cursor + word.length] === "(";
      push(
        !followedByLeftParenthesis &&
          /^\$?[A-Za-z]{1,3}\$?[1-9][0-9]*$/.test(word)
          ? "cell"
          : "identifier",
        word,
      );
      cursor += word.length;
      continue;
    }
    throw new Error(`Unsupported formula character '${character}'`);
  }
  push("eof", "");
  return tokens;
}

function expandRange(
  start: string,
  end: string,
): { addresses: string[]; rowCount: number; columnCount: number } {
  const first = parseCellAddress(start);
  const last = parseCellAddress(end);
  if (last.row < first.row || last.column < first.column) {
    throw new Error("Formula range end must not precede its start");
  }
  const count = (last.row - first.row + 1) * (last.column - first.column + 1);
  if (count > MAX_RANGE_CELLS) {
    throw new Error("Formula range exceeds the 10,000 cell limit");
  }
  const values: string[] = [];
  for (let row = first.row; row <= last.row; row += 1) {
    for (let column = first.column; column <= last.column; column += 1) {
      values.push(`${columnName(column)}${String(row)}`);
    }
  }
  return {
    addresses: values,
    rowCount: last.row - first.row + 1,
    columnCount: last.column - first.column + 1,
  };
}

function parseCellAddress(address: string): { row: number; column: number } {
  const match = /^([A-Z]{1,3})([1-9][0-9]*)$/.exec(
    normalizeCellAddress(address),
  );
  if (!match?.[1] || !match[2]) throw new Error("Invalid formula cell address");
  let column = 0;
  for (const character of match[1]) {
    column = column * 26 + character.charCodeAt(0) - 64;
  }
  return { row: Number.parseInt(match[2], 10), column };
}

function normalizeCellAddress(address: string): string {
  return address.replace(/\$/g, "").toUpperCase();
}

function columnName(value: number): string {
  let remaining = value;
  let result = "";
  while (remaining > 0) {
    remaining -= 1;
    result = String.fromCharCode(65 + (remaining % 26)) + result;
    remaining = Math.floor(remaining / 26);
  }
  return result;
}

function flatten(values: FormulaValue[]): SheetScalar[] {
  return values.flatMap((value) => (isRange(value) ? value.values : [value]));
}

function numeric(value: FormulaValue): number {
  if (isRange(value)) throw new Error("A range cannot be used as a number");
  if (value === null) return 0;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(+value)) {
    return +value;
  }
  throw new Error("Formula expected a numeric value");
}

function formulaText(value: FormulaValue): string {
  const scalar = ensureScalar(value);
  if (scalar === null) return "";
  if (typeof scalar === "boolean") return scalar ? "TRUE" : "FALSE";
  return String(scalar);
}

function safeTextInteger(value: FormulaValue, label: string): number {
  return boundedInteger(value, label, 0, 2_000);
}

function boundedFormulaTextResult(value: string, name: string): string {
  if (value.length > MAX_FORMULA_TEXT_RESULT_CHARACTERS) {
    throw new Error(`${name} result exceeds the safe text length limit`);
  }
  return value;
}

function formatVerifiedTextNumber(value: number, format: string): string {
  const match = /^0(?:\.(0{1,10}))?$/.exec(format);
  if (!match) {
    throw new Error(
      "TEXT is verified only for 0 or 0.0 through 0.0000000000 numeric formats",
    );
  }
  if (Math.abs(value) >= 1e15) {
    throw new Error("TEXT numeric value exceeds the verified magnitude limit");
  }
  const digits = match[1]?.length ?? 0;
  return boundedFormulaTextResult(value.toFixed(digits), "TEXT");
}

function boundedInteger(
  value: FormulaValue,
  label: string,
  minimum: number,
  maximum: number,
): number {
  const integer = numeric(value);
  if (
    !Number.isSafeInteger(integer) ||
    integer < minimum ||
    integer > maximum
  ) {
    throw new Error(
      `${label} must be an integer between ${String(minimum)} and ${String(maximum)}`,
    );
  }
  return integer;
}

function directionalRound(
  value: number,
  digits: number,
  awayFromZero: boolean,
): number {
  const scale = 10 ** digits;
  const scaled = Math.abs(value) * scale;
  const tolerance = Number.EPSILON * Math.max(1, scaled) * 4;
  const magnitude = awayFromZero
    ? Math.ceil(scaled - tolerance)
    : Math.floor(scaled + tolerance);
  return finiteFormulaResult(Math.sign(value) * (magnitude / scale), "ROUND");
}

function finiteFormulaResult(value: number, name: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`${name} result is not a finite number`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function requireRange(value: FormulaValue, label: string): RangeValue {
  if (!isRange(value)) throw new Error(`${label} must be a cell range`);
  return value;
}

function requireCriteriaPairs(
  name: string,
  args: FormulaValue[],
  expectedRange?: RangeValue,
): Array<{ range: RangeValue; criterion: SheetScalar }> {
  if (args.length < 2 || args.length % 2 !== 0) {
    throw new Error(`${name} requires one or more range/criterion pairs`);
  }
  const pairs: Array<{ range: RangeValue; criterion: SheetScalar }> = [];
  let dimensions = expectedRange;
  for (let index = 0; index < args.length; index += 2) {
    const range = requireRange(args[index]!, `${name} criteria range`);
    const criterion = ensureScalar(args[index + 1]!);
    if (dimensions) {
      requireEqualRangeDimensions(name, dimensions, range);
    } else {
      dimensions = range;
    }
    pairs.push({ range, criterion });
  }
  return pairs;
}

function requireEqualRangeDimensions(
  name: string,
  first: RangeValue,
  second: RangeValue,
): void {
  if (
    first.rowCount !== second.rowCount ||
    first.columnCount !== second.columnCount
  ) {
    throw new Error(`${name} ranges must have equal dimensions`);
  }
}

function requireExactLookupMode(value: FormulaValue, name: string): void {
  const mode = ensureScalar(value);
  if (mode !== false && mode !== 0) {
    throw new Error(`${name} only supports verified exact-match mode`);
  }
}

function rangeValueAt(
  range: RangeValue,
  zeroBasedRow: number,
  zeroBasedColumn: number,
): SheetScalar {
  return (
    range.values[zeroBasedRow * range.columnCount + zeroBasedColumn] ?? null
  );
}

function lookupValuesEqual(left: SheetScalar, right: SheetScalar): boolean {
  if (typeof left === "number" && typeof right === "number") {
    return left === right;
  }
  return typeof left === typeof right && left === right;
}

function compareValues(
  left: FormulaValue,
  right: FormulaValue,
  operator: string,
): boolean {
  const first = ensureScalar(left);
  const second = ensureScalar(right);
  const comparable =
    typeof first === "number" && typeof second === "number"
      ? [first, second]
      : [String(first ?? ""), String(second ?? "")];
  switch (operator) {
    case "=":
      return comparable[0] === comparable[1];
    case "<>":
      return comparable[0] !== comparable[1];
    case "<":
      return comparable[0]! < comparable[1]!;
    case ">":
      return comparable[0]! > comparable[1]!;
    case "<=":
      return comparable[0]! <= comparable[1]!;
    case ">=":
      return comparable[0]! >= comparable[1]!;
    default:
      throw new Error(`Unsupported comparison operator: ${operator}`);
  }
}

function matchesCriterion(value: SheetScalar, criterion: SheetScalar): boolean {
  if (typeof criterion !== "string") return value === criterion;
  if (/[*?]/.test(criterion)) {
    throw new Error("Conditional formula wildcard criteria are not verified");
  }
  const match = /^(<=|>=|<>|=|<|>)(.*)$/.exec(criterion);
  if (!match?.[1]) return String(value ?? "") === criterion;
  const operandText = match[2] ?? "";
  const operand =
    operandText.trim() && Number.isFinite(+operandText)
      ? +operandText
      : operandText;
  return compareValues(value, operand, match[1]);
}

function truthy(value: FormulaValue): boolean {
  const scalar = ensureScalar(value);
  if (scalar === null) return false;
  if (typeof scalar === "boolean") return scalar;
  if (typeof scalar === "number") return scalar !== 0;
  return scalar.length > 0;
}

function ensureScalar(value: FormulaValue): SheetScalar {
  if (isRange(value)) throw new Error("A scalar formula value was required");
  return value;
}

function isRange(value: FormulaValue): value is RangeValue {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value as RangeValue).kind === "range",
  );
}
