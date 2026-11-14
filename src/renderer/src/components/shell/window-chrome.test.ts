import { describe, expect, it } from 'vitest'
import {
  MAC_TRAFFIC_LIGHT_INSET,
  WINDOW_CONTROLS_INSET,
  headerRightInset,
  sidebarBrandInset,
  usesCustomWindowControls,
  windowControlsVisible
} from './window-chrome'

describe('window chrome', () => {
  it('uses custom controls on Windows and Linux', () => {
    expect(usesCustomWindowControls('win32')).toBe(true)
    expect(usesCustomWindowControls('linux')).toBe(true)
  })

  it('keeps native controls on macOS', () => {
    expect(usesCustomWindowControls('darwin')).toBe(false)
  })

  it('reserves traffic-light space only on macOS', () => {
    expect(sidebarBrandInset('darwin')).toBe(MAC_TRAFFIC_LIGHT_INSET)
    expect(sidebarBrandInset('win32')).toBe(0)
    expect(sidebarBrandInset('linux')).toBe(0)
  })

  it('reserves control space only for custom chrome', () => {
    expect(headerRightInset('win32')).toBe(WINDOW_CONTROLS_INSET)
    expect(headerRightInset('linux')).toBe(WINDOW_CONTROLS_INSET)
    expect(headerRightInset('darwin')).toBe(0)
  })

  it('keeps controls available at the minimum window width', () => {
    expect(windowControlsVisible(760)).toBe(true)
    expect(windowControlsVisible(759)).toBe(false)
  })
})
