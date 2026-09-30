/** True when a `tasklist /FO CSV /NH` answer for the parent process says it is Windows Explorer (a double-click). */
export function parentIsExplorer(tasklistCsv: string): boolean {
  return /^"explorer\.exe"/im.test(tasklistCsv.trim());
}
