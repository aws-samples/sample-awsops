import { describe, expect, it } from 'vitest';
import { tableTrends } from './table-trends';

describe('explicit time-series tables', () => {
  it('uses source numeric columns with separate units and retains partial-row time labels', () => {
    const result = tableTrends(['시각(UTC)', '요청 수', '에러율(%)', '에러율 그래프', 'p99(ms)'], [
      ['08:30', '5,382', '0.223', '■■■■', '5.68'],
      ['08:35', '5,406', '—', '■■', '4.24'],
      ['08:40*', '5,509', '0.218', '■■■', '9.44'],
    ])!;
    expect(result.data[2].time).toBe('08:40*');
    expect(result.series.map(s => s.label)).toEqual(['요청 수', '에러율(%)', 'p99(ms)']);
    expect(result.data[0].metric0).toBe(5382);
    expect(result.data[1].metric1).toBeNull();
    expect(result.series.map(s => s.key)).not.toContain('metric2');
  });
  it('withholds charts for IDs, non-time tables, malformed numbers and single samples', () => {
    expect(tableTrends(['Resource', 'Count'], [['one', '1'], ['two', '2']])).toBeNull();
    expect(tableTrends(['Time', 'ID'], [['08:30', '1'], ['08:35', '2']])).toBeNull();
    expect(tableTrends(['Time', 'Latency(ms)'], [['08:30', '1.2.3'], ['08:35', '2e999']])).toBeNull();
    expect(tableTrends(['Time', 'Requests'], [['08:30', '10']])).toBeNull();
    expect(tableTrends(['Time', 'Requests'], [['08:30', '10'], ['08:30', '11']])).toBeNull();
    expect(tableTrends(['Time', 'Requests'], [['invalid', '10'], ['08:30', '11']])).toBeNull();
  });
  it('does not silently truncate a table beyond the chart bound or infer magnitude suffixes', () => {
    expect(tableTrends(['Time', 'Requests'], Array.from({ length: 201 }, (_, i) => [`2026-11-10T00:00:${i}Z`, '1']))).toBeNull();
    expect(tableTrends(['Time', 'Requests'], [['08:30', '1K'], ['08:35', '2K']])).toBeNull();
  });
});

it('rejects HTTP status codes and ambiguous leading-zero comma decimal values',()=>{
 expect(tableTrends(['Time','Error code'],[['08:30','404'],['08:35','500']])).toBeNull();
 expect(tableTrends(['Time','Error rate'],[['08:30','0,223'],['08:35','0,218']])).toBeNull();
 expect(tableTrends(['Time','Request count'],[['08:30','1,223'],['08:35','2,218']])!.data[0].metric0).toBe(1223);
});
it('reports additional metric columns instead of silently hiding them',()=>{
 const result=tableTrends(['Time',...Array.from({length:6},(_,i)=>`Request count ${i}`)],[['08:30',...Array(6).fill('1')],['08:35',...Array(6).fill('2')]])!;
 expect(result.series).toHaveLength(4);
 expect(result.omittedSeries).toBe(2);
});
