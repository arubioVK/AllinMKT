import { useEffect, useRef } from 'react'
import * as echarts from 'echarts/core'
import { LineChart, BarChart, ScatterChart } from 'echarts/charts'
import { GridComponent, TooltipComponent, MarkLineComponent, LegendComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { locale } from '../lib/i18n'

echarts.use([LineChart, BarChart, ScatterChart, GridComponent, TooltipComponent, MarkLineComponent, LegendComponent, CanvasRenderer])

// Tema común: rejilla horizontal tenue, sin línea de eje Y, etiquetas grises de 12px,
// líneas rectas de 2px sin marcadores y tooltip sin flecha.
export const chartBase = {
  textStyle: { fontFamily: 'Inter Variable, system-ui, sans-serif', color: '#949494', fontSize: 12 },
  animationDuration: 250,
  grid: { left: 8, right: 8, top: 16, bottom: 4, containLabel: true },
  tooltip: {
    trigger: 'axis',
    backgroundColor: '#2a2a2a',
    borderWidth: 0,
    padding: [8, 10],
    textStyle: { color: '#fff', fontSize: 12 },
    axisPointer: { type: 'line', lineStyle: { color: '#444', width: 1 } }
  }
}

export const axisX = (data: string[]) => ({
  type: 'category' as const,
  data,
  boundaryGap: true,
  axisLine: { lineStyle: { color: '#2a2a2a' } },
  axisTick: { show: false },
  axisLabel: { color: '#949494', fontSize: 12, hideOverlap: true, margin: 12 }
})

export const axisY = (extra: Record<string, unknown> = {}) => ({
  type: 'value' as const,
  splitNumber: 4,
  axisLine: { show: false },
  axisTick: { show: false },
  axisLabel: { color: '#949494', fontSize: 12, formatter: (v: number) => (v >= 1000 ? `${(v / 1000).toLocaleString(locale())} k` : String(v)) },
  splitLine: { lineStyle: { color: '#1f1f1f' } },
  ...extra
})

export function Chart({ option, height = 260, onClick }: { option: Record<string, unknown>; height?: number; onClick?: (p: { dataIndex: number; seriesName?: string }) => void }) {
  const el = useRef<HTMLDivElement>(null)
  const inst = useRef<echarts.ECharts | null>(null)

  useEffect(() => {
    if (!el.current) return
    inst.current = echarts.init(el.current, undefined, { renderer: 'canvas' })
    const ro = new ResizeObserver(() => inst.current?.resize())
    ro.observe(el.current)
    return () => {
      ro.disconnect()
      inst.current?.dispose()
    }
  }, [])

  useEffect(() => {
    inst.current?.setOption({ ...chartBase, ...option }, true)
  }, [option])

  useEffect(() => {
    if (!onClick || !inst.current) return
    const h = (p: unknown): void => onClick(p as { dataIndex: number; seriesName?: string })
    inst.current.on('click', h)
    return () => {
      inst.current?.off('click', h)
    }
  }, [onClick])

  return <div ref={el} style={{ height, width: '100%' }} />
}
