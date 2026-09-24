import initSqlJs from "sql.js";

/**
 * 单一 SQLite 路径：Node（vitest）与浏览器（Vite）都使用 sql.js/WASM，
 * 因而“导出文件 → 删除本地库 → 重新导入”走的是同一份数据库字节，
 * 身份、顺序与来源关系天然保持。
 */
let sqlPromise: Promise<initSqlJs.SqlJsStatic> | null = null;

export async function getSql(): Promise<initSqlJs.SqlJsStatic> {
  if (!sqlPromise) {
    sqlPromise = initSqlJs({
      locateFile: (file: string) => {
        try {
          return new URL(`/node_modules/sql.js/dist/${file}`, document.baseURI).toString();
        } catch {
          return file;
        }
      },
    });
  }
  return sqlPromise;
}
