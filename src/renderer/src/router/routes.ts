/**
 * The shell has exactly one global surface and, when a project is open, one
 * project mode. Keeping this tiny union in one place prevents a component from
 * inventing a second "all projects" route.
 */
export type Surface = 'projects' | 'sessions' | 'tasks' | 'schedules' | 'repositories' | 'settings'

export type ProjectMode = 'sessions' | 'tasks'

export function isProjectSurface(surface: Surface): surface is ProjectMode {
  return surface === 'sessions' || surface === 'tasks'
}

export function projectModeOf(surface: Surface): ProjectMode {
  return surface === 'tasks' ? 'tasks' : 'sessions'
}
