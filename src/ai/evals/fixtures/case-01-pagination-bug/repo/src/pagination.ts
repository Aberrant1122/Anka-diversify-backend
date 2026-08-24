export function getPageOffset(page: number, limit: number): number {
  // BUG: page 1 returns 10 instead of 0
  return page * limit;
}

export function getTotalPages(totalItems: number, limit: number): number {
  return Math.ceil(totalItems / limit);
}
