/// <reference types="vite/client" />
import type { TestConvex } from 'convex-test'
import type { GenericSchema, SchemaDefinition } from 'convex/server'
import { componentsGeneric } from 'convex/server'
import type { ComponentApi } from './component/_generated/component.js'
import schema from './component/schema.js'
const modules = import.meta.glob('./component/**/*.ts')

/**
 * Register the component with a `convex-test` instance, for testing your own
 * functions that send email.
 * @param name - The name you gave the component in convex.config.ts.
 */
export function register(t: TestConvex<SchemaDefinition<GenericSchema, boolean>>, name: string = 'groundmail') {
  t.registerComponent(name, schema, modules)
  return componentsGeneric()[name] as unknown as ComponentApi
}
export default { register, schema, modules }
