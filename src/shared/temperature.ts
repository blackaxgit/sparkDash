export function celsiusToFahrenheit(c: number): number {
  return Math.round(c * 9 / 5 + 32);
}

/** Tooltip formatter for °C-valued history, shown in the user's unit. */
export function tempFormatter(unit: "celsius" | "fahrenheit"): (c: number) => string {
  return (c) => (unit === "fahrenheit" ? `${celsiusToFahrenheit(c)}°F` : `${Number(c.toFixed(1))}°C`);
}
