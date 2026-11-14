// -*- coding: utf-8 -*-

import type { JsonObject } from './types.ts'

/** 自检用的最小运行时导出，同时钉住“原生加载 .ts”这条开发路径。 */
export const TS_PLATFORM = Object.freeze({
  nativeTypeStripping: true,
  buildOutput: 'dist',
}) satisfies Readonly<JsonObject>
