"""Small NumPy classifiers: same inputs, linear versus one tanh hidden layer."""
import json
from pathlib import Path
import time
import numpy as np
from .data import INPUTS


class Predictor:
    def __init__(self,hidden=64,seed=20260925):
        rng=np.random.default_rng(seed); self.hidden=hidden
        if hidden:
            self.params=[rng.normal(0,1/np.sqrt(INPUTS),(INPUTS,hidden)),np.zeros(hidden),
                         rng.normal(0,1/np.sqrt(hidden),(hidden,3)),np.zeros(3)]
        else: self.params=[np.zeros((INPUTS,3)),np.zeros(3)]

    def forward(self,x,mask):
        hidden=np.tanh(x@self.params[0]+self.params[1]) if self.hidden else x
        logits=hidden@self.params[-2]+self.params[-1]
        logits=np.where(mask>0,logits,-np.inf); logits-=np.max(logits,axis=-1,keepdims=True)
        p=np.exp(logits); p/=p.sum(axis=-1,keepdims=True)
        return p,hidden

    def probabilities(self,x,mask):
        return self.forward(x,mask)[0]

    def gradients(self,x,mask,y):
        p,h=self.forward(x,mask)
        loss=-np.log(np.maximum(p[np.arange(len(y)),y],1e-300)).mean()
        dz=p.copy(); dz[np.arange(len(y)),y]-=1; dz/=len(y)
        grads=[h.T@dz,dz.sum(axis=0)]
        if self.hidden:
            dh=(dz@self.params[2].T)*(1-h*h)
            grads=[x.T@dh,dh.sum(axis=0)]+grads
        return float(loss),grads

    def save(self,path):
        np.savez_compressed(path,hidden=self.hidden,**{f'p{i}':p for i,p in enumerate(self.params)})

    @classmethod
    def load(cls,path):
        with np.load(path) as f:
            model=cls(int(f['hidden'])); model.params=[f[f'p{i}'].copy() for i in range(len(model.params))]
        return model


def group_mean(values,groups):
    _,inverse=np.unique(groups,return_inverse=True)
    return np.bincount(inverse,weights=values)/np.bincount(inverse)


def fit(model,train,validation,epochs=50,batch=256,learning_rate=.003,seed=101):
    rng=np.random.default_rng(seed); m=[np.zeros_like(p) for p in model.params]; v=[x.copy() for x in m]
    best=float('inf'); weights=None; best_epoch=0; steps=0; history=[]; start=time.perf_counter()
    for epoch in range(epochs):
        order=rng.permutation(len(train['y']))
        for offset in range(0,len(order),batch):
            ix=order[offset:offset+batch]; steps+=1
            _,grad=model.gradients(train['x'][ix],train['mask'][ix],train['y'][ix])
            for j,g in enumerate(grad):
                m[j]=.9*m[j]+.1*g; v[j]=.999*v[j]+.001*g*g
                model.params[j]-=learning_rate*(m[j]/(1-.9**steps))/(np.sqrt(v[j]/(1-.999**steps))+1e-8)
        p=model.probabilities(validation['x'],validation['mask'])
        nll=-np.log(np.maximum(p[np.arange(len(p)),validation['y']],1e-300))
        value=float(group_mean(nll,validation['group']).mean())
        history.append(value)
        if value<best:
            best=value; best_epoch=epoch+1; weights=[p.copy() for p in model.params]
        if epoch+1-best_epoch>=8: break
    model.params=weights
    return dict(best_epoch=best_epoch,validation_nll=best,validation_curve=history,seconds=time.perf_counter()-start,
                epochs_limit=epochs,batch=batch,learning_rate=learning_rate,seed=seed,
                parameters=sum(p.size for p in weights),weight_bytes=sum(p.nbytes for p in weights))


def train(directory):
    directory=Path(directory)
    # Test file is deliberately never opened during training or selection.
    with np.load(directory/'train.npz') as a,np.load(directory/'validation.npz') as b:
        training={k:a[k] for k in ('x','mask','y','group')}; validation={k:b[k] for k in ('x','mask','y','group')}
    result={}
    for name,hidden in (('linear',0),('neural',64)):
        model=Predictor(hidden); result[name]=fit(model,training,validation)
        model.save(directory/f'{name}.npz')
        print('trained',name,result[name]['best_epoch'],result[name]['validation_nll'],flush=True)
    (directory/'training.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    return result
