import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'vite'
async function bundled(entry) {
 const result=await build({configFile:false,publicDir:false,logLevel:'silent',build:{write:false,lib:{entry,formats:['es']}}})
 return import(`data:text/javascript;base64,${Buffer.from(result[0].output[0].code).toString('base64')}`)
}
const {createProject,createTrack,trackIsMuted}=await bundled('src/domain/model.ts')
const {applySessionTemplate,SESSION_TEMPLATES}=await bundled('src/domain/templates.ts')
test('Solo Safe preserva áudio em solo, mas respeita mute e inativação',()=>{
 const t=createTrack('Aux')
 assert.equal(trackIsMuted(t,true),true)
 assert.equal(trackIsMuted({...t,soloSafe:true},true),false)
 assert.equal(trackIsMuted({...t,solo:true},true),false)
 assert.equal(trackIsMuted({...t,soloSafe:true,mute:true},true),true)
 assert.equal(trackIsMuted({...t,soloSafe:true,inactive:true},false),true)
})
test('modelos têm IDs independentes, formatos mono/estéreo e instrumentos vazios',()=>{
 for(const key of Object.keys(SESSION_TEMPLATES)) {
  const a=applySessionTemplate(createProject('A'),key),b=applySessionTemplate(createProject('B'),key)
  assert.equal(new Set([...a.tracks,...b.tracks].map(t=>t.id)).size,a.tracks.length+b.tracks.length)
  assert.equal(a.assets.length,0)
  assert.ok(a.tracks.every(t=>!t.armed && t.vst3Inserts.length===0 && t.clipIds.length===0))
 }
 const band=applySessionTemplate(createProject('Banda'),'band')
 assert.equal(band.tracks.length,8)
 assert.equal(band.tracks.find(t=>t.name==='Bateria').recordChannels,2)
 assert.equal(applySessionTemplate(createProject('MIDI'),'production').tracks.filter(t=>t.kind==='midi').length,4)
 assert.equal(applySessionTemplate(createProject('Podcast'),'podcast').metronomeEnabled,false)
})
