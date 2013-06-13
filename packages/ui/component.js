var constructorsLocked = true;

Component = function (args) {
  if (constructorsLocked)
    throw new Error("To create a Component, " +
                    "use ComponentClass.create(...)");
  constructorsLocked = true;

  this.stage = Component.UNADDED;

  this._uniqueIdCounter = 1;

  // UNINITED Components get these:
  this._args = args || {};
  this._argDeps = {};

  // INITED Components get these:
  this.key = '';
  this.parent = null;
  this.children = {};

  // BUILT Components get these:
  this._start = null; // first Component or Node
  this._end = null; // last Component or Node
  this.isAttached = false;
  this._detachedContent = null; // DocumentFragment

  this._buildUpdater = null;
  this._childUpdaters = {};
  this.elements = {};

  this.constructed();
};

// life stages of a Component
_.extend(Component, {
  UNADDED: ['UNADDED'],
  ADDED: ['ADDED'],
  BUILT: ['BUILT'],
  DESTROYED: ['DESTROYED']
});

// Fills in for _start and _end on a temporary basis.
var EMPTY = ['EMPTY'];

_.extend(Component.prototype, {
  _requireStage: function (stage) {
    if (this.stage !== stage)
      throw new Error("Need " + stage + " Component, found " +
                      this.stage + " Component.");
  },
  _added: function (key, parent) {
    this._requireStage(Component.UNADDED);
    this.key = key;
    this.parent = parent;
    this.stage = Component.ADDED;
    this.init();
  },
  build: function () {
    var self = this;
    self._requireStage(Component.ADDED);
    self._buildUpdater =
      Deps.autorun(function (c) {
        var isRebuild = (self.stage === Component.BUILT);
        var oldFirstNode, oldLastNode;
        if (isRebuild) {
          oldFirstNode = self.firstNode();
          oldLastNode = self.lastNode();
          Deps.nonreactive(function () {
            for (var k in self.children) {
              if (self.children.hasOwnProperty(k)) {
                var child = self.children[k];
                child.destroy();
                self.removeChild(child.key);
              }
            }
          });
          self.elements = {};
          self.stage = Component.ADDED;
        }
        var buf = new RenderBuffer(self);
        self.render(buf);
        var buildResult = buf.build();
        if (isRebuild) {
          var parentNode = oldFirstNode.parentNode;
          var beforeNode = oldLastNode.nextSibling;
          DomUtils.extractRange(oldFirstNode, oldLastNode);
          parentNode.insertBefore(buildResult.fragment,
                                  beforeNode);
        } else {
          self._detachedContent = buildResult.fragment;
        }
        self._start = buildResult.start;
        self._end = buildResult.end;

        self.stage = Component.BUILT;
        Deps.nonreactive(function () {
          if (c.firstRun) {
            self.built();
          } else {
            self.rebuilt();
          }
        });
      });
  },
  destroy: function () {
    // Leaves the DOM and component hierarchy in place

    if (this.stage === Component.DESTROYED)
      return;

    var oldStage = this.stage;
    this.stage = Component.DESTROYED;

    if (oldStage === Component.UNADDED)
      return;

    if (this._buildUpdater)
      this._buildUpdater.stop();

    for (var k in this._childUpdaters) {
      if (this._childUpdaters.hasOwnProperty(k)) {
        this._childUpdaters[k].stop();
        delete this._childUpdaters[k];
      }
    }

    // maybe GC sooner
    this._start = null;
    this._end = null;

    this.destroyed();

    var children = this.children;
    for (var k in children)
      if (children.hasOwnProperty(k))
        children[k].destroy();
  },
  attach: function (parentNode, beforeNode) {
    var self = this;
    if (self.stage === Component.ADDED) // not built
      self.build();

    var parent = self.parent;

    self._requireStage(Component.BUILT);
    if (self.isAttached)
      throw new Error("Component already attached");

    if ((! parentNode) || ! parentNode.nodeType)
      throw new Error("first argument of attach must be a Node");
    if (beforeNode && ! beforeNode.nodeType)
      throw new Error("second argument of attach must be a Node" +
                      " if given");

    var frag = self._detachedContent;

    if (DomUtils.wrapFragmentForContainer(frag, parentNode))
      self.setBounds(frag.firstChild, frag.lastChild);

    parentNode.insertBefore(frag, beforeNode);
    self._detachedContent = null;

    self.isAttached = true;

    if (parent && parent.stage === Component.BUILT) {
      if (parent._start === EMPTY) {
        parent.setBounds(self);
      } else {
        if (parent.firstNode() === self.lastNode().nextSibling)
          parent.setStart(self);
        if (parent.lastNode() === self.firstNode().previousSibling)
          parent.setEnd(self);
      }
    }

    self.attached();
  },
  detach: function (_allowTransientEmpty) {
    var self = this;
    var parent = self.parent;

    if (parent)
      parent._requireStage(Component.BUILT);
    self._requireStage(Component.BUILT);
    if (! self.isAttached)
      throw new Error("Component not attached");

    if (parent) {
      if (parent._start === comp) {
        if (parent._end === comp) {
          if (_allowTransientEmpty)
            parent._start = parent._end = EMPTY;
          else
            throw new Error("Can't detach entire contents of " +
                            "Component; use swapInChild instead");
        } else {
          var newFirstNode = comp.lastNode().nextSibling;
          var foundComp = null;
          for (var k in parent.children) {
            if (parent.children.hasOwnProperty(k) &&
                parent.children[k].firstNode() === newFirstNode) {
              foundComp = parent.children[k];
              break;
            }
          }
          parent.setStart(foundComp || newFirstNode);
        }
      } else if (parent._end === comp) {
        var newLastNode = comp.firstNode().previousSibling;
        var foundComp = null;
        for (var k in parent.children) {
          if (parent.children.hasOwnProperty(k) &&
              parent.children[k].lastNode() === newLastNode) {
            foundComp = parent.children[k];
            break;
          }
        }
        parent.setEnd(foundComp || newLastNode);
      }
    }

    self._detachedContent = document.createDocumentFragment();

    DomUtils.extractRange(self.firstNode(), self.lastNode(),
                          self._detachedContent);

    self.isAttached = false;

    self.detached();
  },
  swapInChild: function (toAttach, toDetach) {
    var parentNode = toDetach.parentNode();
    var beforeNode = toDetach.lastNode().nextSibling;
    toDetach.detach(true);
    toAttach.attach(parentNode, beforeNode);
  }
});

// Once the Component is built, if the Component implementation
// modifies the DOM composition of the Component, it must specify
// the new bounds using some combination of these.
_.extend(Component.prototype, {
  setStart: function (start) {
    this._requireStage(Component.BUILT);

    if (! ((start instanceof Component &&
            start.stage === Component.BUILT) ||
           (start && start.nodeType)))
      throw new Error("start must be a built Component or a Node");

    this._start = start;
  },
  setEnd: function (end) {
    this._requireStage(Component.BUILT);

    if (! ((end instanceof Component &&
            end.stage === Component.BUILT) ||
           (end && end.nodeType)))
      throw new Error("end must be a built Component or a Node");

    this._end = end;
  },
  setBounds: function (start, end) {
    end = end || start;
    this.setStart(start);
    this.setEnd(end);
  },
  firstNode: function () {
    this._requireStage(Component.BUILT);
    return this._start instanceof Component ?
      this._start.firstNode() : this._start;
  },
  lastNode: function () {
    this._requireStage(Component.BUILT);
    return this._end instanceof Component ?
      this._end.lastNode() : this._end;
  },
  parentNode: function () {
    return this.firstNode().parentNode;
  },
  findOne: function (selector) {
    return DomUtils.findClipped(
      this.parentNode(), selector,
      this.firstNode(), this.lastNode());
  },
  findAll: function (selector) {
    return DomUtils.findAllClipped(
      this.parentNode(), selector,
      this.firstNode(), this.lastNode());
  }
});

_.extend(Component.prototype, {
  getArg: function (argName) {
    var dep = (this._argDeps.hasOwnProperty(argName) ?
               this._argDeps[argName] :
               (this._argDeps[argName] = new Deps.Dependency));
    dep.depend();
    return this._args[argName];
  },
  update: function (args) {
    var oldArgs = this._args;
    this._args = args;

    var argDeps = this._argDeps;

    for (var k in args) {
      if (args.hasOwnProperty(k) &&
          argDeps.hasOwnProperty(k) &&
          ! EJSON.equals(args[k], oldArgs[k])) {
        argDeps[k].changed();
        delete oldArgs[k];
      }
    }
    for (var k in oldArgs) {
      if (oldArgs.hasOwnProperty(k) &&
          argDeps.hasOwnProperty(k)) {
        argDeps[k].changed();
      }
    }

    this.updated(args, oldArgs);
  }
});

_.extend(Component.prototype, {
  hasChild: function (key) {
    return this.children.hasOwnProperty(key);
  },
  addChild: function (key, childComponentOrFunc,
                      attachParentNode,
                      attachBeforeNode) {
    if ((key instanceof Component) ||
        ((typeof key) === 'function')) {
      // omitted key arg
      childComponentOrFunc = key;
      key = null;
    }

    // omitted key, generate unique child key
    if (key === null || typeof key === 'undefined')
      key = "__child#" + (this._uniqueIdCounter++) + "__";
    key = String(key);

    var self = this;
    if (self.stage === Component.DESTROYED)
      throw new Error("parent Component already destroyed");
    if (self.stage === Component.UNADDED)
      throw new Error("parent Component is unadded");

    if (self.hasChild(key))
      throw new Error("Already have a child with key: " + key);

    var childComponent;
    if (typeof childComponentOrFunc === 'function') {
      var func = childComponentOrFunc;
      this._childUpdaters[key] =
        Deps.autorun(function (c) {
          if (c.firstRun) {
            childComponent = func();
            return;
          }
          var oldChild = self.children[key];
          if ((! (oldChild instanceof Component)) ||
              oldChild.stage === Component.DESTROYED) {
            // child shouldn't be missing, but may be
            // destroyed
            c.stop();
            return;
          }
          var newChild = func();
          if (! (newChild instanceof Component))
            throw new Error("not a Component: " + newChild);
          if (oldChild.constructor === newChild.constructor) {
            oldChild.update(newChild._args);
          } else {
            self.replaceChild(key, newChild);
          }
        });
    } else {
      childComponent = childComponentOrFunc;
    }

    if (! (childComponent instanceof Component))
      throw new Error("not a Component: " + childComponent);

    childComponent._requireStage(Component.UNADDED);

    self.children[key] = childComponent;

    childComponent._added(key, self);

    if (attachParentNode) {
      if (self.stage !== Component.BUILT)
        throw new Error("Attaching new child requires built " +
                        "parent Component");
      childComponent.attach(attachParentNode, attachBeforeNode);
    }

    return childComponent;
  },
  removeChild: function (key, _allowTransientEmpty) {
    // note: must work if child is destroyed

    key = String(key);

    if (this.stage === Component.DESTROYED)
      throw new Error("parent Component already destroyed");
    if (this.stage === Component.UNADDED)
      throw new Error("parent Component is unadded");

    if (! this.hasChild(key))
      throw new Error("No such child component: " + key);

    var childComponent = this.children[key];
    if (childComponent.stage === Component.BUILT &&
        childComponent.isAttached)
      childComponent.detach(_allowTransientEmpty);

    delete this.children[key];

    if (this._childUpdaters[key]) {
      this._childUpdaters[key].stop();
      delete this._childUpdaters[key];
    }

    childComponent.parent = null;

    childComponent.destroy();
  },
  replaceChild: function (key, newChild) {
    if (this.stage === Component.DESTROYED)
      throw new Error("parent Component already destroyed");
    if (this.stage === Component.UNADDED)
      throw new Error("parent Component is unadded");

    if (! this.hasChild(key))
      throw new Error("No such child component: " + key);

    if (! (newChild instanceof Component))
      throw new Error("Component required");

    var oldChild = this.children[key];

    if (oldChild.constructor === newChild.constructor) {
      oldChild.update(newChild._args);
    } else if (this.stage !== Component.BUILT ||
               oldChild !== Component.BUILT ||
               ! oldChild.isAttached) {
      this.removeChild(key);
      this.addChild(key, newChild);
    } else {
      // swap attached child
      var parentNode = oldChild.parentNode();
      var beforeNode = oldChild.lastNode().nextSibling;
      this.removeChild(key, true);
      this.addChild(key, newChild, parentNode, beforeNode);
    }
  },
  registerElement: function (elementKey, element) {
    this.elements[elementKey] = element;
  }
});

_.extend(Component.prototype, {
  constructed: function () {},
  init: function () {},
  render: function (buf) {},
  updated: function (args, oldArgs) {},
  destroyed: function () {},
  attached: function () {},
  detached: function () {},
  built: function () {},
  rebuilt: function () {}
});


// Require ComponentClass.create(...) instead of
// new CompomentClass(...) because a factory method gives
// us more flexibility, and there should be one way to
// make a component.  The `new` syntax is awkward if
// the component class is calculated by a complex expression
// (like a reactive getter).
Component.create = function (/*args*/) {
  constructorsLocked = false;
  var comp = new this;
  Component.apply(comp, arguments);
  return comp;
};

Component.extend = function (options) {
  var superClass = this;
  // all constructors just call the base constructor
  var newClass = function CustomComponent() {
    if (constructorsLocked)
      throw new Error("To create a Component, " +
                      "use ComponentClass.create(...)");
    // (Component.create kicks off construction)
  };

  // Establish a prototype link from newClass.prototype to
  // superClass.prototype.  This is similar to making
  // newClass.prototype a `new superClass` but bypasses
  // the constructor.
  var fakeSuperClass = function () {};
  fakeSuperClass.prototype = superClass.prototype;
  newClass.prototype = new fakeSuperClass;

  // Record the superClass for our future use.
  newClass.superClass = superClass;

  // Inherit class (static) properties from parent.
  _.extend(newClass, superClass);

  // For callbacks, call one in turn from super to sub.
  // Or rather, redefine each callback we are given to call
  // super method first.
  // XXX TODO: clean this up.
  // - General combining mechanism?  Filtering mechanism?
  // - Get the lookup hash out of here!
  _.each(options, function (v, k) {
    // important that we have a closure here to capture
    // each old function!
    var oldFunction = v;
    if ({init:1,
         destroyed:1,
         updated:1,
         attached:1,
         detached:1,
         built:1,
         rebuilt:1,
         constructed:1
        }.hasOwnProperty(k)) {
      options[k] = function () {
        superClass.prototype[k].apply(this, arguments);
        oldFunction.apply(this, arguments);
      };
    }
  });

  // Add instance properties and methods.
  if (options)
    _.extend(newClass.prototype, options);

  // For browsers that don't support it, fill in `obj.constructor`.
  newClass.prototype.constructor = newClass;

  newClass.create = Component.create;

  return newClass;
};

TextComponent = Component.extend({
  render: function (buf) {
    buf.text(this.getArg('text'));
  }
});

RawHtmlComponent = Component.extend({
  render: function (buf) {
    buf.rawHtml(this.getArg('html'));
  }
});

RootComponent = Component.extend({
  constructed: function () {
    this.stage = Component.ADDED;
  },
  render: function (buf) {
    var bodyClass = this.getArg('bodyClass');
    if (bodyClass)
      buf.component(bodyClass.create(), {key: 'body'});
  }
});
