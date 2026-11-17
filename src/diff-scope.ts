export function diffScope(names: string, excludePaths: string[]) {
  const fields = names.split("\0");
  if (fields.pop() !== "") throw new Error("Invalid Git file list");
  const patterns = excludePaths.map((pattern) => new Bun.Glob(pattern));
  const changedFiles: string[] = [];
  const excludedFiles: string[] = [];
  const excludedPaths: string[] = [];
  for (let index = 0; index < fields.length; ) {
    const status = fields[index++];
    const source = fields[index++];
    if (!status || !/^[ACDMRTUXB][0-9]*$/.test(status) || !source)
      throw new Error("Invalid Git file list");
    const destination = /^[RC]/.test(status) ? fields[index++] : source;
    if (!destination) throw new Error("Invalid Git rename");
    changedFiles.push(destination);
    if (
      patterns.some(
        (pattern) => pattern.match(source) || pattern.match(destination),
      )
    ) {
      excludedFiles.push(destination);
      // Exclude both sides so Git cannot turn an excluded rename into a deletion.
      excludedPaths.push(source, destination);
    }
  }
  return {
    changedFiles,
    excludedFiles,
    excludedPaths: [...new Set(excludedPaths)],
  };
}
