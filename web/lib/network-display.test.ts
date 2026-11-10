import { expect,it } from 'vitest';
import { networkDisplay } from './network-display';
import type { NetworkTopology } from './network-topology-types';
const node=(id:string,kind:any,parent:string|null,label=id)=>({id,kind,parent,label,accountId:'example',region:'us-east-1'});
const input:NetworkTopology={level:'fleet',nodes:[node('account','account',null),node('region','region','account'),node('vpc','vpc','region','shop'),node('hub','tgw','region'),node('other','vpc','region')],edges:[{id:'edge',kind:'tgw',source:'hub',target:'vpc',recordId:'record',crossAccount:false}],capturedAt:'capture',omitted:{inactive:1,conflicting:2,resourcesCapped:3},truncated:true};
it('keeps one-hop counterpart and parents without expanding unrelated fleet resources',()=>{
 const result=networkDisplay(input,'shop',false);
 expect(result.nodes.map(n=>n.id)).toEqual(['account','region','vpc','hub']);
 expect(result.edges).toEqual(input.edges);
 expect(result.omitted).toBe(input.omitted);
 expect(result.capturedAt).toBe('capture'); expect(result.truncated).toBe(true);
 expect(networkDisplay(input,'absent',false).nodes).toEqual([]);
});
it('limits connected-only to fleet and never filters detail resources',()=>{
 expect(networkDisplay(input,'',true).nodes.map(n=>n.id)).not.toContain('other');
 const detail:NetworkTopology={...input,level:'detail',nodes:[...input.nodes,node('subnet','subnet','vpc'),node('instance','ec2','subnet')]};
 expect(networkDisplay(detail,'absent',true)).toBe(detail);
});
it('does not loop while preserving cyclic parent references',()=>{
 const cyclic={...input,nodes:[node('a','vpc','b','shop'),node('b','region','a')],edges:[]};
 expect(networkDisplay(cyclic,'shop',false).nodes).toHaveLength(2);
});
