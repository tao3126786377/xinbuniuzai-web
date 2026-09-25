"""Calibrated forecasts and causal likelihood-based expert weights.

These weights compare experts; they are NOT probabilities that a player is
in-distribution. Neural parameters stay frozen. Only public-action evidence moves.
"""
from dataclasses import dataclass
import json
from pathlib import Path
import numpy as np
from scipy.optimize import minimize
from scipy.special import logsumexp
from ..phase2.network import Predictor,group_mean
from ..phase2.data import features,dense
from ..rules import actions

TEMPERATURES=(.75,1.,1.5,2.,3.,4.)
SHARES=(0.,.005,.01,.05,.1,.2)


def calibrate(p,temperature):
    logits=np.where(p>0,np.log(np.maximum(p,1e-300))/temperature,-np.inf)
    return np.exp(logits-logsumexp(logits,axis=-1,keepdims=True))


@dataclass(frozen=True)
class Evidence:
    log_weights: tuple=(-float(np.log(3)),)*3
    observations: int=0

    @property
    def weights(self):
        return np.exp(self.log_weights)

    def update(self,experts,action,share,event_id):
        if event_id!=self.observations+1: raise ValueError('Observation must be revealed exactly once, in order')
        if not 0<=share<1: raise ValueError('Invalid sharing rate')
        likelihood=experts[:,action]
        if np.any(likelihood<=0) or not np.all(np.isfinite(likelihood)):
            raise ValueError('Observed action must have positive finite expert likelihoods')
        logs=np.asarray(self.log_weights)+np.log(likelihood); logs-=logsumexp(logs)
        if share: logs=np.logaddexp(np.log1p(-share)+logs,np.log(share/3))
        return Evidence(tuple(float(x) for x in logs),event_id)


def expert_array(data,temperatures):
    uniform=data['mask']/data['mask'].sum(axis=1,keepdims=True)
    return np.stack([calibrate(data['neural'],temperatures['neural']),
                     calibrate(data['linear'],temperatures['linear']),uniform],axis=1)


def replay(experts,targets,groups,share):
    predictions=np.empty((len(targets),3)); weights=np.empty_like(predictions); previous=None
    for i,(p,y,group) in enumerate(zip(experts,targets,groups)):
        if group!=previous: evidence=Evidence(); previous=group
        weights[i]=evidence.weights; predictions[i]=weights[i]@p
        evidence=evidence.update(p,int(y),share,evidence.observations+1)
    return predictions,weights


def nll(p,y,groups):
    losses=-np.log(np.maximum(p[np.arange(len(y)),y],1e-300))
    return float(group_mean(losses,groups).mean())


def select(directory):
    directory=Path(directory)
    # Calibration and all hyperparameters use validation only; test is never opened.
    with np.load(directory/'validation.npz') as f: data={k:f[k] for k in ('neural','linear','mask','y','group')}
    temperatures={}; scan={}
    for name in ('linear','neural'):
        scan[name]={str(t):nll(calibrate(data[name],t),data['y'],data['group']) for t in TEMPERATURES}
        temperatures[name]=min(TEMPERATURES,key=lambda t:scan[name][str(t)])
    experts=expert_array(data,temperatures); likelihood=experts[np.arange(len(experts)),:,data['y']]
    _,inverse,counts=np.unique(data['group'],return_inverse=True,return_counts=True)
    weight=1/counts[inverse]/len(counts)
    def objective(w): return -float(weight@np.log(np.maximum(likelihood@w,1e-300)))
    def gradient(w): return -(weight/np.maximum(likelihood@w,1e-300))@likelihood
    opt=minimize(objective,np.ones(3)/3,jac=gradient,method='SLSQP',bounds=[(0,1)]*3,
                 constraints=[dict(type='eq',fun=lambda w:w.sum()-1,jac=lambda w:np.ones(3))],
                 options={'ftol':1e-12,'maxiter':200})
    if not opt.success: raise ArithmeticError(opt.message)
    weights=np.maximum(opt.x,0); weights/=weights.sum()
    shares={}
    for share in SHARES:
        pred,_=replay(experts,data['y'],data['group'],share)
        shares[str(share)]=nll(pred,data['y'],data['group'])
        print('validation share',share,shares[str(share)],flush=True)
    chosen=min(SHARES,key=lambda s:shares[str(s)])
    result=dict(temperatures=temperatures,temperature_scan=scan,static_weights=weights.tolist(),
                static_validation_nll=objective(weights),share=chosen,share_scan=shares,
                experts=['calibrated_neural','calibrated_linear','uniform'],criterion='lowest validation profile-mean NLL',
                updates='post-reveal likelihood update followed by uniform fixed-share; no neural retraining')
    (directory/'selection.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    return result


class Forecast:
    def __init__(self,directory):
        directory=Path(directory)
        self.selection=json.loads((directory/'selection.json').read_text(encoding='utf-8'))
        self.neural=Predictor.load(directory/'neural.npz'); self.linear=Predictor.load(directory/'linear.npz')

    def experts(self,s,history,eq):
        ah=actions(s)[1]; mask=dense(np.ones(len(ah)),ah); x=features(s,history,eq)
        raw=self.neural.probabilities(x,mask); linear=self.linear.probabilities(x,mask)
        t=self.selection['temperatures']
        return np.array([calibrate(raw,t['neural']),calibrate(linear,t['linear']),mask/mask.sum()]),raw

    def predict(self,kind,experts,raw,evidence):
        if kind=='neural': return raw
        if kind=='calibrated': return experts[0]
        if kind=='linear': return experts[1]
        if kind=='static': return np.asarray(self.selection['static_weights'])@experts
        if kind in ('adaptive','frozen'): return evidence.weights@experts
        if kind=='equilibrium': return experts[2]  # unused for choosing equilibrium actions
        raise ValueError(kind)
